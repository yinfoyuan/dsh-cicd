import type { Runner } from './runner.js'
import type { Project, RunRecord, WatchHooks } from './types.js'
/**
 * 后台跟踪器：`cicd_run` 返回后继续轮询，阶段变化/结束主动提示。
 *
 * 目的：`cicd_run` 触发后对话立即空闲（不等待、不 sleep），
 * 运行有进展或结束时通过 client toast / dsh-pet 气泡通知；
 * `followUp: true` 时终态调用 `onTerminal`、首次检测到合并冲突调用 `onConflict`，
 * 由调用方唤醒模型继续后续动作。
 */
import { durationText } from './runner.js'

const FIRST_DELAY_MS = 5_000
const MAX_DELAY_MS = 15_000
const MAX_WATCH_MS = 45 * 60_000

/** RunWatcher 只依赖 runner 的两个查询方法，测试可以传最小桩。 */
export interface WatcherRunner {
  status: Runner['status']
  logs: Runner['logs']
}

export interface RunWatcherOptions {
  /** 推送一条提示（客户端 toast / 桌宠）；project/runId 用于历史里按运行去重。 */
  notice: (text: string, project?: string, runId?: string) => void
}

function label(record: RunRecord): string {
  const env = record.environment ? `[${record.environment}] ` : ''
  return `${env}${record.title || record.pipeline}`
}

/** 从失败日志里识别「合并冲突 / 被取消」这类需要人工处理的情况。 */
export function failureHint(log: string): string {
  if (/merge conflict|CONFLICT|合并冲突/i.test(log))
    return '分支合并冲突，请先解决冲突再重试'
  if (/用户已取消|UserCanceled|CANCELED/i.test(log))
    return '任务被取消（可能是冲突后手动取消）'
  return ''
}

/**
 * 运行中但日志显示「合并冲突、任务暂停」：云效会停在这里等用户手动合并，
 * 点页面上的「Conflict Resolved」后才会继续。
 */
export function mergeConflictPending(log: string): boolean {
  return /Merge conflicted,\s*job paused|自动合并失败|修正冲突|冲突（内容）|Conflict Resolved|合并冲突/i.test(log)
}

export class RunWatcher {
  #runner: WatcherRunner
  #options: RunWatcherOptions
  #timers = new Map<string, NodeJS.Timeout>()
  #disposed = false

  constructor(runner: WatcherRunner, options: RunWatcherOptions) {
    this.#runner = runner
    this.#options = options
  }

  /** 开始跟踪一次运行；同一个 runId 只跟踪一次。 */
  watch(project: Project, record: RunRecord, hooks?: WatchHooks): void {
    if (this.#disposed || this.#timers.has(record.runId))
      return
    const startedAt = Date.now()
    let lastProgress = record.progress ?? ''
    let delay = FIRST_DELAY_MS
    let lastLogCheck = 0
    let conflictNotified = false
    let waitingNotified = false
    let hint = ''

    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    const tick = async (): Promise<void> => {
      this.#timers.delete(record.runId)
      if (this.#disposed)
        return

      let current = record
      try {
        current = await this.#runner.status(project, { runId: record.runId })
      }
      catch {
        // 查询失败不终止跟踪：按退避继续。
      }
      if (this.#disposed)
        return

      const terminal = current.status !== 'running' && current.status !== 'lost'
      if (terminal) {
        // 用户主动取消：终态 toast 保留，但不再唤醒模型（取消结果已经在 `cicd_cancel` 的返回里）。
        const userCanceled = current.status === 'canceled' && current.canceledByUser === true
        let text = current.status === 'succeeded'
          ? `✅ ${label(current)} 执行成功（${durationText(current.durationMs ?? 0)}）`
          : current.status === 'failed'
            ? `❌ ${label(current)} 执行失败（${durationText(current.durationMs ?? 0)}）`
            : current.status === 'canceled'
              ? `⛔ ${label(current)} 已取消`
              : `❓ ${label(current)} 状态丢失`

        if (current.status === 'failed') {
          try {
            const log = await this.#runner.logs(project, { runId: current.runId, tailLines: 120, maxChars: 12_000 })
            hint = failureHint(log)
            if (hint)
              text += ` · ${hint}`
          }
          catch {}
        }
        try {
          this.#options.notice(text, project.root, current.runId)
        }
        catch {}
        // 只有 `cicd_run followUp: true` 才会传回调：终态唤醒模型继续用户交代的后续动作。
        // 用户主动取消不唤醒，避免「刚取消又被叫醒」；toast 仍然保留。
        if (!userCanceled) {
          try {
            hooks?.onTerminal?.(current, hint)
          }
          catch {}
        }
        return
      }

      const waitingText = String(current.waiting ?? '')
      if (waitingText) {
        // 等待人工操作时不要再刷「阶段运行中」，只提示一次「在等人」。
        lastProgress = current.progress ?? lastProgress
        if (!waitingNotified) {
          waitingNotified = true
          try {
            this.#options.notice(
              `⏸ ${label(current)} 在等人工操作：${waitingText}。请在云效处理（例如人工卡点需要点「通过」），插件不会自动确认。`,
              project.root,
              current.runId,
            )
          }
          catch {}
          try {
            hooks?.onWaiting?.(current)
          }
          catch {}
        }
      }
      else if (waitingNotified) {
        waitingNotified = false
        try {
          this.#options.notice(`▶ ${label(current)} 人工操作已处理，继续运行`, project.root, current.runId)
        }
        catch {}
      }

      if (!waitingText && current.progress && current.progress !== lastProgress) {
        lastProgress = current.progress
        try {
          this.#options.notice(`⏳ ${label(current)} · ${current.progress}`, project.root, current.runId)
        }
        catch {}
      }

      // 分支集成阶段可能「暂停等人工合并」：日志里出现冲突标记时主动提示一次。
      // 云效把冲突写进 job result（provider 会转成 record.note）：优先用它，避免多打日志接口。
      const announceConflict = (): void => {
        conflictNotified = true
        try {
          this.#options.notice(`⚠️ ${label(current)} 检测到合并冲突，运行在等你手动处理：请在云效解决冲突后点「Conflict Resolved」（不要退出流水线）。`, project.root, current.runId)
        }
        catch {}
        // 冲突暂停不是终态，但用户可能正是在关注冲突：按 followUp 约定唤醒一次。
        try {
          hooks?.onConflict?.(current)
        }
        catch {}
      }
      const note = String(current.note ?? '')
      if (!conflictNotified && /合并冲突|Conflict Resolved|Merge conflicted/i.test(note))
        announceConflict()

      // 没有 note 时再从日志里兜底识别（兼容老数据/其他平台）。
      if (!conflictNotified && Date.now() - lastLogCheck >= 15_000) {
        lastLogCheck = Date.now()
        try {
          const log = await this.#runner.logs(project, { runId: current.runId, tailLines: 120, maxChars: 12_000 })
          if (mergeConflictPending(log))
            announceConflict()
        }
        catch {}
      }

      if (Date.now() - startedAt > MAX_WATCH_MS) {
        try {
          this.#options.notice(`⏳ ${label(current)} 仍在执行，后台跟踪已停止；可稍后用 cicd_status 查看`, project.root, current.runId)
        }
        catch {}
        return
      }

      delay = Math.min(delay + 5_000, MAX_DELAY_MS)
      this.#timers.set(record.runId, setTimeout(() => {
        void tick()
      }, delay))
    }

    this.#timers.set(record.runId, setTimeout(() => {
      void tick()
    }, delay))
  }

  dispose(): void {
    this.#disposed = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }
}
