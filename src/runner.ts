import type { ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import type { ConflictInfo } from './conflict.js'
import type {
  ApprovalAction,
  LogOptions,
  Pipeline,
  PipelineRunSummary,
  PipelineVariable,
  PluginContext,
  PollResult,
  Project,
  RunRecord,
  ShellPipeline,
  TriggerResult,
  WaitAbortReason,
  WaitMeta,
  WaitResult,
} from './types.js'
/**
 * 触发、跟踪、读取日志、取消。
 *
 * shell 流水线在本进程 spawn 子进程，输出直接写进 `<项目>/.dsh/cicd-runs/<runId>.log`；
 * HTTP 类流水线只记录平台返回的 run id，状态按需轮询（不做后台定时器）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseConflictInfo } from './conflict.js'
import { createProvider, isRetryable } from './providers.js'
import { resolveCredential } from './secrets.js'
import { readGlobalSettings } from './settings-store.js'
import {
  ensureRunsDir,
  latestRecord,
  listRecords,
  loadRecord,
  logPath,
  makeRunId,
  readLogTail,
  saveRecord,
  TERMINAL,
} from './state.js'

export class PipelineError extends Error {
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'PipelineError'
    this.hint = hint
  }
}

export class ConfirmRequired extends Error {
  pipeline: Pipeline

  constructor(pipeline: Pipeline) {
    super(`流水线「${pipeline.name}」被标记为需要确认（confirm: true）。`)
    this.name = 'ConfirmRequired'
    this.pipeline = pipeline
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms))

/** 运行记录里不落 `envs` 的值：变量值可能在会话外被输入，只保留变量名。 */
function stripSensitiveParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'envs')
      out[key] = value
  }
  return out
}

/** 内部 `Runner.wait` 的默认/最大等待预算（秒）；不通过工具暴露。 */
export const DEFAULT_WAIT_SEC = 180 // 没有历史耗时时的默认值：3 分钟
export const MAX_WAIT_SEC = 300
/** 等待时最多容忍连续几次查询失败（之后停止等待，别再空耗预算）。 */
export const WAIT_MAX_ERRORS = 4

interface IntervalShape {
  base?: number
  max?: number
  factor?: number
}

/**
 * 自适应轮询间隔：从 base 起步，按 factor 退避到 max 封顶。
 * 云效一次构建 3~5 分钟，固定 1.5s 轮询会打上百次接口；退避后通常只打十几次。
 */
export function nextPollInterval(
  currentMs: number,
  { base = 2_000, max = 15_000, factor = 1.6 }: IntervalShape = {},
): number {
  const grown = Math.max(base, currentMs * factor)
  return Math.min(max, Math.round(grown))
}

/** 给轮询间隔加 ±ratio 的抖动，避免多个等待同时打到同一秒。 */
export function jittered(
  ms: number,
  { ratio = 0.15, random = Math.random }: { ratio?: number, random?: () => number } = {},
): number {
  const delta = ms * ratio * (random() * 2 - 1)
  return Math.max(150, Math.round(ms + delta))
}

/** 按上一次同类运行耗时估个等待预算：耗时 ×1.25 + 20s，夹在 60~300 秒。 */
export function suggestWaitSec(lastDurationMs: number): number {
  if (!lastDurationMs || lastDurationMs <= 0)
    return DEFAULT_WAIT_SEC
  const guess = Math.round((lastDurationMs / 1000) * 1.25 + 20)
  return Math.min(MAX_WAIT_SEC, Math.max(60, guess))
}

/**
 * 查询出错后要不要继续等：
 * - 不可重试（400/401/403/404 之类）→ 立刻停，重试也不会好；
 * - 可重试但连续失败太多次 → 停，交给调用方排查；
 * - 其余 → 继续按退避重试。
 */
export function waitAbortReason(
  { errorStreak = 0, retryable = true }: { errorStreak?: number, retryable?: boolean } = {},
): WaitAbortReason {
  if (!errorStreak)
    return ''
  if (!retryable)
    return 'fatal'
  if (errorStreak >= WAIT_MAX_ERRORS)
    return 'gave-up'
  return ''
}

/** 记录里没写 durationMs 时，用 startedAt/finishedAt 兜底算一次。 */
function durationBetween(record: RunRecord | null | undefined): number {
  const saved = Number(record?.durationMs)
  if (Number.isFinite(saved) && saved > 0)
    return saved
  const started = new Date(record?.startedAt ?? 0).getTime()
  const finished = new Date(record?.finishedAt ?? 0).getTime()
  if (Number.isFinite(started) && Number.isFinite(finished) && finished > started)
    return finished - started
  return 0
}

/** 找同一条流水线上一次「跑完过」的运行耗时（优先成功的那次）。 */
function lastRunDurationMs(project: Project, record: RunRecord): number {
  const records = listRecords(project.runsDir, 80)
    .filter(item => item.runId !== record.runId && item.pipeline === record.pipeline)
    .map(item => ({ item, durationMs: durationBetween(item) }))
    .filter(({ durationMs }) => durationMs > 0)
  const picked = records.find(({ item }) => item.status === 'succeeded') ?? records[0]
  return picked?.durationMs ?? 0
}

export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '-'
  if (ms < 1000)
    return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60)
    return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

interface ShellMeta {
  child: ChildProcess
  log: WriteStream
  canceled: boolean
  timedOut: boolean
  done: boolean
  timer: NodeJS.Timeout | null
  project: Project
}

export class Runner {
  /** 正在跑的 shell 子进程。 */
  children: Map<string, ShellMeta> = new Map()
  /** 同一个 runId 的并发 wait 共用一次轮询，避免重复打接口。 */
  waiting: Map<string, Promise<WaitResult>> = new Map()
  #ctx?: PluginContext

  constructor(ctx?: PluginContext) {
    this.#ctx = ctx
  }

  /**
   * 每次操作前解析一次 `tokenEnv`（DSH credential-ref 语义）：
   * 凭据服务可用就覆盖本地 env，改凭据不需要重启；不可用则用 `project.env`。
   */
  async #envFor(project: Project, pipeline: Pipeline): Promise<Project['env']> {
    const env = { ...project.env }
    const globalRef = readGlobalSettings().tokenRef
    const globalValue = await resolveCredential(this.#ctx, globalRef)
    if (globalValue) {
      const target = (pipeline as { tokenEnv?: string }).tokenEnv || globalRef
      env[target] = globalValue
      env[globalRef] = globalValue
    }
    const ref = (pipeline as { tokenEnv?: string }).tokenEnv
    if (ref && !env[ref]) {
      const value = await resolveCredential(this.#ctx, ref)
      if (value)
        env[ref] = value
    }
    return env
  }

  #activeShellCount(): number {
    let n = 0
    for (const meta of this.children.values()) {
      if (!meta.done)
        n++
    }
    return n
  }

  #kill(runId: string): void {
    const meta = this.children.get(runId)
    if (!meta)
      return
    const { child } = meta
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      }
      else {
        try {
          process.kill(-child.pid!, 'SIGTERM')
        }
        catch {
          child.kill('SIGTERM')
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          }
          catch {}
        }, 3000).unref()
      }
    }
    catch {}
  }

  async run(
    project: Project,
    name: string,
    { params = {}, confirm = false }: { params?: Record<string, unknown>, confirm?: boolean } = {},
  ): Promise<RunRecord> {
    const pipeline = project.config.pipelines[name]
    if (!pipeline) {
      throw new PipelineError(
        `没有名为「${name}」的流水线。已配置：${Object.keys(project.config.pipelines).join('、')}`,
        `配置在 ${project.configPath}`,
      )
    }
    if (pipeline.confirm && !confirm)
      throw new ConfirmRequired(pipeline)

    const triggerParams = params ?? {}
    const envs = (triggerParams as { envs?: unknown }).envs
    const overriddenVariables = envs && typeof envs === 'object' && !Array.isArray(envs)
      ? Object.keys(envs as Record<string, unknown>)
      : []

    const record: RunRecord = {
      runId: makeRunId(name),
      pipeline: name,
      title: pipeline.title,
      type: pipeline.type,
      status: 'running',
      startedAt: new Date().toISOString(),
      // 运行记录不落 envs 的值：只保留覆盖的变量名，值只在内存里传给平台。
      params: stripSensitiveParams(triggerParams),
      projectRoot: project.root,
      serverPid: process.pid,
      ...(pipeline.environment ? { environment: pipeline.environment } : {}),
      ...(pipeline.tier ? { tier: pipeline.tier } : {}),
      ...(overriddenVariables.length > 0 ? { overriddenVariables } : {}),
    }
    saveRecord(project.runsDir, record)

    if (pipeline.type === 'shell')
      return this.#runShell(project, pipeline, record)

    const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
    const out: TriggerResult = await provider.trigger({ params: triggerParams })
    Object.assign(record, {
      externalId: out.externalId ?? '',
      url: out.url ?? '',
      note: out.note ?? '',
      branches: out.branches && out.branches.length > 0 ? out.branches : undefined,
      variables: out.variables && out.variables.length > 0 ? out.variables : undefined,
      checkedAt: new Date().toISOString(),
    })
    saveRecord(project.runsDir, record)
    return record
  }

  /** 只读：运行变量定义（只有 key/描述/标记，值不读取）。 */
  async variables(project: Project, { pipeline }: { pipeline?: string } = {}): Promise<PipelineVariable[]> {
    const name = String(pipeline ?? '').trim()
    if (!name)
      throw new PipelineError('缺少流水线名称。', '先用 cicd_list 查看可用的流水线。')
    const target = project.config.pipelines[name]
    if (!target)
      throw new PipelineError(`没有名为「${name}」的流水线。已配置：${Object.keys(project.config.pipelines).join('、')}`)
    if (target.type !== 'yunxiao')
      throw new PipelineError('只有云效（yunxiao）流水线有运行变量。', 'shell 流水线没有平台运行变量。')
    const provider = createProvider(target, await this.#envFor(project, target))
    return provider.variables ? provider.variables() : []
  }

  /** 只读：平台侧最近运行列表（不含变量值/日志）。 */
  async runs(project: Project, { pipeline, limit = 10 }: { pipeline?: string, limit?: number } = {}): Promise<PipelineRunSummary[]> {
    const name = String(pipeline ?? '').trim()
    const yunxiao = Object.values(project.config.pipelines).filter(item => item.type === 'yunxiao')
    const target = name
      ? project.config.pipelines[name]
      : (yunxiao.length === 1 ? yunxiao[0] : undefined)
    if (!target) {
      if (name)
        throw new PipelineError(`没有名为「${name}」的流水线。已配置：${Object.keys(project.config.pipelines).join('、')}`)
      throw new PipelineError(
        yunxiao.length > 1 ? '有多条云效流水线，请指定 pipeline。' : '当前项目没有云效流水线。',
        yunxiao.length > 1 ? `可用：${yunxiao.map(item => item.name).join('、')}` : '先用 cicd_list 查看配置。',
      )
    }
    if (target.type !== 'yunxiao')
      throw new PipelineError('只有云效（yunxiao）流水线有平台运行历史。', 'shell 流水线请查本地运行记录。')
    const provider = createProvider(target, await this.#envFor(project, target))
    return provider.runs ? provider.runs(limit) : []
  }

  /** 写操作：通过/拒绝人工卡点；必须显式 confirm。 */
  async approve(
    project: Project,
    { runId, action, confirm }: { runId?: string, action?: string, confirm?: boolean } = {},
  ): Promise<{ record: RunRecord, note: string }> {
    if (!confirm)
      throw new PipelineError('人工卡点审批必须显式确认（confirm: true）。', '先把要操作的环境、阶段和动作告诉用户并得到同意。')
    const id = String(runId ?? '').trim()
    if (!id)
      throw new PipelineError('缺少 runId。', '用 cicd_status / cicd_runs 找到运行。')
    if (action !== 'pass' && action !== 'refuse')
      throw new PipelineError('action 只能是 pass 或 refuse。')
    const record = loadRecord(project.runsDir, id)
    if (!record)
      throw new PipelineError(`找不到运行记录：${id}`, '用 cicd_list / cicd_status 查看最近的 runId。')
    if (record.status !== 'running')
      throw new PipelineError(`运行已经是 ${record.status}，没有可审批的人工卡点。`)
    const pipeline = project.config.pipelines[record.pipeline]
    if (!pipeline)
      throw new PipelineError(`流水线「${record.pipeline}」已从配置里移除，无法审批。`)
    if (pipeline.type !== 'yunxiao')
      throw new PipelineError('只有云效（yunxiao）流水线有人工卡点。', 'shell 流水线没有平台审批。')
    const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
    if (!provider.approve)
      throw new PipelineError('当前平台适配器不支持人工卡点审批。')
    const out = await provider.approve(record, action as ApprovalAction)
    const refreshed = (await this.refresh(project, record).catch(() => record)) ?? record
    return { record: refreshed, note: out.note ?? '' }
  }

  #runShell(project: Project, pipeline: ShellPipeline, record: RunRecord): RunRecord {
    if (this.#activeShellCount() >= project.config.defaults.maxConcurrent) {
      throw new PipelineError(
        `同时运行的 shell 流水线已达上限 ${project.config.defaults.maxConcurrent} 条。`,
        '等其中一条结束，或调大 .dsh/cicd.json 的 defaults.maxConcurrent。',
      )
    }

    const cwd = resolve(project.root, pipeline.cwd || '.')
    if (!existsSync(cwd)) {
      throw new PipelineError(`工作目录不存在：${cwd}`, '检查流水线的 cwd 配置（相对项目根目录）。')
    }

    ensureRunsDir(project.runsDir)
    const file = logPath(project.runsDir, record.runId)
    const log = createWriteStream(file, { flags: 'a' })
    // 子进程被强杀时 stdout 仍可能在收尾写入；不要让这类竞态冒成未捕获异常。
    log.on('error', () => {})
    log.write(`# ${pipeline.title} (${pipeline.name})\n# runId: ${record.runId}\n# cwd:   ${cwd}\n# cmd:   ${pipeline.command}\n# start: ${record.startedAt}\n\n`)

    const isWin = process.platform === 'win32'
    const commandFile = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
    const commandArgs = isWin ? ['/d', '/s', '/c', pipeline.command] : ['-c', pipeline.command]

    const child = spawn(commandFile, commandArgs, {
      cwd,
      env: {
        ...project.env,
        ...Object.fromEntries(Object.entries(pipeline.env ?? {}).map(([k, v]) => [k, String(v)])),
        PIPELINE_NAME: pipeline.name,
        PIPELINE_RUN_ID: record.runId,
      } as NodeJS.ProcessEnv,
      windowsHide: true,
      detached: !isWin,
      // cmd.exe 不认 libuv 的引号转义：命令里带 "..." 时必须原样传命令行。
      windowsVerbatimArguments: isWin,
    })

    const meta: ShellMeta = { child, log, canceled: false, timedOut: false, done: false, timer: null, project }
    this.children.set(record.runId, meta)

    record.pid = child.pid
    record.logFile = file
    saveRecord(project.runsDir, record)

    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })

    meta.timer = setTimeout(() => {
      meta.timedOut = true
      this.#kill(record.runId)
    }, (pipeline.timeoutSec ?? project.config.defaults.timeoutSec) * 1000)
    meta.timer.unref?.()

    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (meta.done)
        return
      meta.done = true
      if (meta.timer)
        clearTimeout(meta.timer)
      this.children.delete(record.runId)

      const rec: RunRecord = loadRecord(project.runsDir, record.runId) ?? record
      rec.finishedAt = new Date().toISOString()
      rec.exitCode = typeof code === 'number' ? code : null
      rec.durationMs = Date.now() - new Date(rec.startedAt).getTime()

      if (error) {
        rec.status = 'failed'
        rec.note = `启动/运行失败：${error.message}`
      }
      else if (meta.canceled) {
        rec.status = 'canceled'
        rec.canceledByUser = true
      }
      else if (meta.timedOut) {
        rec.status = 'failed'
        rec.note = `超时（>${pipeline.timeoutSec ?? project.config.defaults.timeoutSec}s）被终止`
      }
      else {
        rec.status = code === 0 ? 'succeeded' : 'failed'
      }

      log.write(`\n[pipeline] ${rec.status} exit=${rec.exitCode ?? '-'} duration=${durationText(rec.durationMs)}${signal ? ` signal=${signal}` : ''}${rec.note ? ` note=${rec.note}` : ''}\n`)
      log.end()
      saveRecord(project.runsDir, rec)
    }

    child.on('close', (code, signal) => finish(code, signal))
    child.on('error', error => finish(null, null, error))

    return record
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
  async refresh(project: Project, record: RunRecord | null): Promise<RunRecord | null> {
    if (!record)
      return record

    if (record.type === 'shell') {
      const meta = this.children.get(record.runId)
      if (meta && !meta.done) {
        return {
          ...record,
          status: 'running',
          elapsedMs: Date.now() - new Date(record.startedAt).getTime(),
        } as RunRecord
      }

      // 子进程刚结束、close 回调还没落盘时，磁盘上的记录可能仍是 running。
      // 只有「确定是上一个 DSH 进程留下的」才标记 lost。
      const latest = loadRecord(project.runsDir, record.runId) ?? record
      if (latest.status === 'running' && latest.serverPid !== process.pid) {
        const rec: RunRecord = { ...latest, status: 'lost', note: 'DSH 重启后丢失了子进程句柄：运行可能仍在继续，请用进程列表/日志确认。' }
        saveRecord(project.runsDir, rec)
        return rec
      }
      return latest
    }

    if (TERMINAL.has(record.status)) {
      // 老记录可能只有 finishedAt 没有 durationMs，补一次，免得「上次耗时」一直是空。
      const ms = durationBetween(record)
      if (ms > 0 && record.durationMs !== ms) {
        const next: RunRecord = { ...record, durationMs: ms }
        saveRecord(project.runsDir, next)
        return next
      }
      return record
    }

    const pipeline = project.config.pipelines[record.pipeline]
    if (!pipeline)
      return record

    try {
      const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
      const out: PollResult = await provider.poll(record)
      const next: RunRecord = { ...record }
      next.status = out.status
      if (out.url)
        next.url = out.url
      if (out.rawStatus)
        next.rawStatus = out.rawStatus
      if (out.note)
        next.note = out.note
      if (out.progress)
        next.progress = out.progress
      if (out.waiting)
        next.waiting = out.waiting
      else
        delete next.waiting
      if (out.branches?.length)
        next.branches = out.branches
      if (out.buildUrl)
        next.buildUrl = out.buildUrl
      if (out.exitCode !== undefined)
        next.exitCode = out.exitCode
      next.checkedAt = new Date().toISOString()
      if (TERMINAL.has(next.status)) {
        next.finishedAt = next.finishedAt ?? next.checkedAt
        const ms = durationBetween(next)
        if (ms > 0)
          next.durationMs = ms
      }
      delete next.checkError
      delete next.checkErrorRetryable
      saveRecord(project.runsDir, next)
      return next
    }
    catch (error) {
      const next: RunRecord = {
        ...record,
        checkError: (error as Error).message,
        checkErrorRetryable: isRetryable(error),
        checkedAt: new Date().toISOString(),
      }
      saveRecord(project.runsDir, next)
      return next
    }
  }

  async status(project: Project, { runId, pipeline }: { runId?: string, pipeline?: string } = {}): Promise<RunRecord> {
    const record = runId
      ? loadRecord(project.runsDir, runId)
      : latestRecord(project.runsDir, pipeline)
    if (!record) {
      throw new PipelineError(
        runId ? `找不到运行记录：${runId}` : `流水线「${pipeline}」还没有运行记录。`,
        '先用 cicd_run 触发一次，或调用 cicd_list 查看可用流水线。',
      )
    }
    // 本地已取消是终态：平台事后可能把 run 标成 FAIL，不要把它改回失败。
    if (record.status === 'canceled')
      return record
    return (await this.refresh(project, record)) as RunRecord
  }

  async logs(project: Project, { runId, tailLines, maxChars }: { runId?: string, tailLines?: number, maxChars?: number } = {}): Promise<string> {
    const record = loadRecord(project.runsDir, runId ?? '')
    if (!record)
      throw new PipelineError(`找不到运行记录：${runId}`, '用 cicd_list / cicd_status 查看最近的 runId。')

    const lines = Number(tailLines) > 0 ? Number(tailLines) : project.config.defaults.logTailLines
    const chars = Number(maxChars) > 0 ? Number(maxChars) : 20_000

    if (record.type === 'shell') {
      const text = readLogTail(project.runsDir, record.runId, lines, chars)
      return text || '（这次运行还没有输出）'
    }

    const pipeline = project.config.pipelines[record.pipeline]
    if (!pipeline)
      return `（流水线「${record.pipeline}」已从配置里移除，无法取日志）`
    const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
    try {
      return await provider.logs(record, { tailLines: lines, maxChars: chars } satisfies LogOptions)
    }
    catch (error) {
      return `读取日志失败：${(error as Error).message}`
    }
  }

  /**
   * 只读：读取合并冲突相关的结构化信息（冲突文件、release/feature 分支、日志尾部）。
   * 不会解决冲突，也不会让流水线继续。
   */
  async conflict(project: Project, { runId }: { runId: string }): Promise<{ record: RunRecord, info: ConflictInfo }> {
    const record = loadRecord(project.runsDir, runId)
    if (!record)
      throw new PipelineError(`找不到运行记录：${runId}`, '用 cicd_list / cicd_status 查看最近的 runId。')
    if (record.type !== 'yunxiao') {
      throw new PipelineError('只有云效（yunxiao）多分支流水线有合并冲突信息。', 'shell 流水线没有 merge 阶段。')
    }
    const pipeline = project.config.pipelines[record.pipeline]
    if (!pipeline)
      throw new PipelineError(`流水线「${record.pipeline}」已从配置里移除，无法读取冲突信息。`)
    const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
    const log = provider.conflictLogs
      ? await provider.conflictLogs(record)
      : await provider.logs(record, { tailLines: 200, maxChars: 20_000 })
    return { record, info: parseConflictInfo(log) }
  }

  /**
   * 等到运行结束（或预算用完）。
   *
   * - 自适应退避：云效 2s → 15s 封顶，shell 250ms → 2s 封顶，带抖动；
   * - 等待预算：不传 timeoutSec 时参考上一次跑完的耗时（×1.25+20s，60~300s），
   *   没有历史就默认 180s（3 分钟）；
   * - 同一个 runId 的并发 wait 共用一次轮询（`waiting` 表）；
   * - 查询出错：可重试错误继续退避重试，连续 4 次失败或遇到 4xx（凭证/配置问题）就停止等待，
   *   原因写进 `meta.abortReason`（fatal / gave-up），别把时间耗在不会恢复的错误上；
   * - 返回 `{ record, meta }`，meta 里有轮询次数、耗时、预算来源、错误次数、是否超时。
   */
  async wait(project: Project, { runId, timeoutSec }: { runId: string, timeoutSec?: number }): Promise<WaitResult> {
    const key = `${project.root}::${runId}`
    const existing = this.waiting.get(key)
    if (existing)
      return existing

    const task = this.#waitOnce(project, { runId, timeoutSec }).finally(() => this.waiting.delete(key))
    this.waiting.set(key, task)
    return task
  }

  async #waitOnce(project: Project, { runId, timeoutSec }: { runId: string, timeoutSec?: number }): Promise<WaitResult> {
    const record = loadRecord(project.runsDir, runId)
    if (!record)
      throw new PipelineError(`找不到运行记录：${runId}`, '用 cicd_list / cicd_status 查看最近的 runId。')

    // 不传 timeoutSec 时：参考同一条流水线上一次跑完的耗时；没有历史就默认 3 分钟。
    const explicit = Number(timeoutSec)
    const hasExplicit = Number.isFinite(explicit) && explicit > 0
    let budget: number
    let budgetSource: WaitMeta['budgetSource']
    let lastDurationMs = 0
    if (hasExplicit) {
      budget = Math.min(Math.max(Math.round(explicit), 5), MAX_WAIT_SEC)
      budgetSource = 'param'
    }
    else {
      lastDurationMs = lastRunDurationMs(project, record)
      budget = suggestWaitSec(lastDurationMs)
      budgetSource = lastDurationMs > 0 ? 'history' : 'default'
    }

    const deadline = Date.now() + budget * 1000
    const startedAt = Date.now()
    // shell 是本进程的子进程，本地查询很便宜，轮询密一点；HTTP 类走公网接口，退避要果断。
    const shape: IntervalShape = record.type === 'shell' ? { base: 250, max: 2_000 } : { base: 2_000, max: 15_000 }
    let interval = shape.base!
    let polls = 0
    let lastError = ''
    let errorStreak = 0
    let abortReason: WaitAbortReason = ''

    // 查询失败时：累计连续失败次数，并判断要不要停。
    const track = (rec: RunRecord): WaitAbortReason => {
      if (!rec.checkError) {
        errorStreak = 0
        return ''
      }
      lastError = rec.checkError
      errorStreak += 1
      return waitAbortReason({ errorStreak, retryable: rec.checkErrorRetryable !== false })
    }

    let current = (await this.refresh(project, record)) as RunRecord
    polls += 1
    abortReason = track(current)

    while (!abortReason && !TERMINAL.has(current.status)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        break
      interval = nextPollInterval(interval, shape)
      await sleep(Math.min(jittered(interval), remaining))
      current = (await this.refresh(project, current)) as RunRecord
      polls += 1
      abortReason = track(current)
    }

    return {
      record: current,
      meta: {
        polls,
        elapsedMs: Date.now() - startedAt,
        timedOut: !TERMINAL.has(current.status) && !abortReason,
        abortReason,
        errorStreak,
        budgetSec: budget,
        budgetSource,
        lastDurationMs,
        lastError,
      },
    }
  }

  async cancel(project: Project, { runId }: { runId?: string } = {}): Promise<RunRecord> {
    const record = loadRecord(project.runsDir, runId ?? '')
    if (!record)
      throw new PipelineError(`找不到运行记录：${runId}`, '用 cicd_list / cicd_status 查看最近的 runId。')
    if (TERMINAL.has(record.status))
      return record

    if (record.type === 'shell') {
      const meta = this.children.get(record.runId)
      if (meta) {
        meta.canceled = true
        this.#kill(record.runId)
        return { ...record, status: 'canceled', canceledByUser: true }
      }
      const next: RunRecord = { ...record, status: 'canceled', finishedAt: new Date().toISOString(), note: '没有找到活动子进程，已标记为取消', canceledByUser: true }
      saveRecord(project.runsDir, next)
      return next
    }

    const pipeline = project.config.pipelines[record.pipeline]
    if (!pipeline)
      throw new PipelineError(`流水线「${record.pipeline}」已从配置里移除，无法取消。`)
    const provider = createProvider(pipeline, await this.#envFor(project, pipeline))
    const out = await provider.cancel(record)
    const next: RunRecord = { ...record, status: 'canceled', finishedAt: new Date().toISOString(), note: out?.note ?? '', canceledByUser: true }
    saveRecord(project.runsDir, next)
    return next
  }

  dispose(): void {
    for (const [runId, meta] of this.children) {
      try {
        // 先标记 done，close 回调之后就不会再往已经 end 的日志流里写。
        meta.done = true
        meta.canceled = true
        if (meta.timer)
          clearTimeout(meta.timer)
        this.#kill(runId)

        const rec = loadRecord(meta.project.runsDir, runId)
        if (rec && rec.status === 'running') {
          rec.status = 'canceled'
          rec.finishedAt = new Date().toISOString()
          rec.note = '插件卸载 / DSH 退出时被清理'
          saveRecord(meta.project.runsDir, rec)
        }
        // 先断开 pipe，再结束流：否则子进程残留的输出会触发 write after end。
        meta.child.stdout?.unpipe(meta.log)
        meta.child.stderr?.unpipe(meta.log)
        meta.log?.end()
      }
      catch {}
    }
    this.children.clear()
  }
}
