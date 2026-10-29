import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AskBranchesOptions, BranchChoice, RunConfigChoice, RunConfigOptions } from './prompt.js'
import type { PipelineVariable, PluginContext } from './types.js'
/**
 * 分支选择的自定义弹窗通道（host 侧）。
 *
 * DSH 的通用 `ctx.userQuestions` 不支持「默认全部勾选」，所以多分支选择用插件自己的
 * client 组件：client 注册在 `shell.overlay`，轮询这里的 HTTP 路由拿请求、提交答案。
 *
 * 协议（同一 DSH webServer 下）：
 *   GET  /dsh-cicd/branch/request  → { request: { id, title, previous } | null }（同时标记 client 在线）
 *   POST /dsh-cicd/branch/answer   → { id, selected: 保留的分支[], custom: 新增文本, cancelled? }
 *   GET  /dsh-cicd/health          → { ok: true }
 *
 * 没有 client（未安装/未加载）时由调用方回退到 `ctx.userQuestions`。
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parseKeepAnswer, parseRunConfigAnswer } from './prompt.js'
import { readGlobalSettings } from './settings-store.js'

interface WebServerLike {
  register: (spec: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }) => void
}

interface NoticeRecord {
  seq: unknown
  text: string
  level?: unknown
  at?: unknown
  count?: unknown
  project?: unknown
  runId?: unknown
}

function isNoticeRecord(value: unknown): value is NoticeRecord {
  if (!value || typeof value !== 'object')
    return false
  const record = value as Record<string, unknown>
  return typeof record.text === 'string' && Number.isFinite(Number(record.seq))
}

const ROUTE_PREFIX = '/dsh-cicd'
const CLIENT_TTL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 120_000

/** 通知历史落盘位置（全局，不属于某个项目）。 */
export function defaultNoticeStorePath(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cicd-notices.json')
}

interface ClientAnswer {
  selected?: string[]
  custom?: string
  envs?: Record<string, unknown>
  comment?: string
  cancelled?: boolean
}

interface ClientNotice {
  seq: number
  text: string
  level: string
  at: number
  /** 连续重复的次数（同一次运行内只剩最新一条展示）。 */
  count?: number
  /** 触发通知的项目根（全局历史里用来区分来源）。 */
  project?: string
  /** 触发通知的运行 id（去重按「同一次运行」而不是纯文本）。 */
  runId?: string
}

interface PendingRequest {
  id: string
  kind: 'branch' | 'runConfig'
  title: string
  previous: string[]
  variables?: PipelineVariable[]
  showBranches?: boolean
  showComment?: boolean
  comment?: string
  envs?: Record<string, string>
  environment?: string
  tier?: string
  resolve: (answer: ClientAnswer) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text)
    return null
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

export class BranchBroker {
  #ctx: PluginContext
  #pending: PendingRequest | null = null
  #lastSeen = 0
  #registered = false
  #notices: ClientNotice[] = []
  #noticeSeq = 0
  #storePath: string
  #config?: { handle: (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => Promise<boolean> }

  constructor(ctx: PluginContext, options: { storePath?: string } = {}) {
    this.#ctx = ctx
    this.#storePath = options.storePath ?? defaultNoticeStorePath()
    this.#load()
  }

  /** 往 client 的 toast 队列里推一条提示（非阻塞、best-effort，并落盘）。 */
  notify(text: string, level = 'info', project?: string, runId?: string): void {
    const trimmed = String(text ?? '').trim()
    if (!trimmed)
      return

    // 同一次运行内连续重复的文本（例如持续停在同一个阶段）只保留最新一条，累计次数；
    // 不同运行即使文本一样也分开记录。
    const last = this.#notices[this.#notices.length - 1]
    if (
      last
      && last.text === trimmed
      && (last.project ?? '') === (project ?? '')
      && (last.runId ?? '') === (runId ?? '')
    ) {
      last.at = Date.now()
      last.count = (last.count ?? 1) + 1
      this.#persist()
      return
    }

    this.#notices.push({
      seq: ++this.#noticeSeq,
      text: trimmed,
      level,
      at: Date.now(),
      count: 1,
      ...(project ? { project } : {}),
      ...(runId ? { runId } : {}),
    })
    if (this.#notices.length > readGlobalSettings().historyLimit) {
      this.#notices.splice(0, this.#notices.length - readGlobalSettings().historyLimit)
    }
    this.#persist()
  }

  clearNotices(): void {
    this.#notices = []
    this.#persist()
  }

  /** 读取历史（best-effort）：文件不存在/损坏就当空历史。 */
  #load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#storePath, 'utf8'))
      const container = raw as { notices?: unknown }
      const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(container.notices) ? container.notices : []
      this.#notices = list
        .filter(isNoticeRecord)
        .map(item => ({
          seq: Number(item.seq),
          text: String(item.text),
          level: String(item.level ?? 'info'),
          at: Number(item.at) || Date.now(),
          ...(Number(item.count) > 1 ? { count: Number(item.count) } : {}),
          ...(item.project ? { project: String(item.project) } : {}),
          ...(item.runId ? { runId: String(item.runId) } : {}),
        }))
        .slice(-readGlobalSettings().historyLimit)
      this.#noticeSeq = this.#notices.reduce((max, item) => Math.max(max, item.seq), 0)
    }
    catch {
      this.#notices = []
      this.#noticeSeq = 0
    }
  }

  #persist(): void {
    try {
      mkdirSync(dirname(this.#storePath), { recursive: true })
      writeFileSync(this.#storePath, JSON.stringify({ notices: this.#notices }), 'utf8')
    }
    catch {
      // 落盘失败不影响通知本身
    }
  }

  /** 注册 HTTP 路由；没有 webServer 时返回 false（调用方回退 userQuestions）。 */
  registerRoutes(): boolean {
    const webServer = this.#ctx.get?.('webServer', false) as WebServerLike | undefined
    if (!webServer?.register)
      return false
    try {
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => this.#handle(req, res),
      })
      this.#registered = true
      return true
    }
    catch {
      return false
    }
  }

  /** 最近 5 秒内有 client 轮询过，说明自定义弹窗可用。 */
  hasClient(): boolean {
    return this.#registered && Date.now() - this.#lastSeen < CLIENT_TTL_MS
  }

  /** 请求用户选择分支；client 不可用时应由调用方先判断 hasClient()。 */
  ask(options: AskBranchesOptions): Promise<BranchChoice> {
    this.#rejectPending(new Error('分支选择被新的运行请求替换'))
    return new Promise<BranchChoice>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id)
          return
        this.#pending = null
        reject(new Error(`等待分支选择超时（${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s）：请重试，或直接用 branches 参数指定`))
      }, DEFAULT_TIMEOUT_MS)
      timer.unref?.()

      this.#pending = {
        id,
        kind: 'branch',
        title: options.title,
        previous: options.previous,
        environment: options.environment,
        tier: options.tier,
        timer,
        resolve: (answer) => {
          clearTimeout(timer)
          if (this.#pending?.id === id)
            this.#pending = null
          if (answer.cancelled) {
            reject(new Error('用户取消了本次运行'))
            return
          }
          try {
            const choice = parseKeepAnswer(options.previous, { selected: answer.selected, custom: answer.custom })
            if (choice.branches.length === 0) {
              reject(new Error('多分支流水线至少要有一个运行分支：请至少保留一个，或在输入框里新增一个'))
              return
            }
            resolve(choice)
          }
          catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
        reject: (error) => {
          clearTimeout(timer)
          if (this.#pending?.id === id)
            this.#pending = null
          reject(error)
        },
      }
    })
  }

  /** 请求「运行配置」弹窗（分支 + 运行变量 + 备注）；client 不可用时由调用方回退。 */
  askRunConfig(options: RunConfigOptions): Promise<RunConfigChoice> {
    this.#rejectPending(new Error('运行配置请求被新的运行请求替换'))
    return new Promise<RunConfigChoice>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id)
          return
        this.#pending = null
        reject(new Error(`等待运行配置超时（${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s）：请重试，或用 envs / branches 参数直接指定`))
      }, DEFAULT_TIMEOUT_MS)
      timer.unref?.()

      this.#pending = {
        id,
        kind: 'runConfig',
        title: options.title,
        previous: options.previous,
        variables: options.variables,
        showBranches: options.showBranches,
        showComment: options.showComment,
        comment: options.comment,
        envs: options.envs,
        environment: options.environment,
        tier: options.tier,
        timer,
        resolve: (answer) => {
          clearTimeout(timer)
          if (this.#pending?.id === id)
            this.#pending = null
          if (answer.cancelled) {
            reject(new Error('用户取消了本次运行'))
            return
          }
          try {
            resolve(parseRunConfigAnswer(options, answer))
          }
          catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
        reject: (error) => {
          clearTimeout(timer)
          if (this.#pending?.id === id)
            this.#pending = null
          reject(error)
        },
      }
    })
  }

  dispose(): void {
    this.#rejectPending(new Error('插件已卸载，分支选择请求已取消'))
  }

  #rejectPending(error: Error): void {
    const pending = this.#pending
    this.#pending = null
    if (pending)
      pending.reject(error)
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    void this.#route(req, res).catch((error) => {
      try {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      catch {}
    })
  }

  /** 接入设置页的配置 API（与分支/通知共用同一 webServer 前缀）。 */
  attachConfig(service: { handle: (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => Promise<boolean> }): void {
    this.#config = service
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (this.#config && await this.#config.handle(req, res, path, url))
      return

    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/health`) {
      this.#lastSeen = Date.now()
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/notices`) {
      this.#lastSeen = Date.now()
      const rawSince = Number(url.searchParams.get('since') ?? '0')
      const since = Number.isFinite(rawSince) ? rawSince : 0
      sendJson(res, 200, {
        notices: this.#notices.filter(notice => notice.seq > since),
        seq: this.#noticeSeq,
      })
      return
    }

    // 设置页的「最近通知」：返回全部保留的历史，最新在前。
    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/notices/history`) {
      this.#lastSeen = Date.now()
      const rawLimit = Number(url.searchParams.get('limit') ?? '50')
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), readGlobalSettings().historyLimit)
      sendJson(res, 200, {
        notices: [...this.#notices].reverse().slice(0, limit),
        seq: this.#noticeSeq,
      })
      return
    }

    if (req.method === 'POST' && path === `${ROUTE_PREFIX}/notices/clear`) {
      this.clearNotices()
      sendJson(res, 200, { ok: true, seq: this.#noticeSeq })
      return
    }

    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/branch/request`) {
      this.#lastSeen = Date.now()
      sendJson(res, 200, {
        request: this.#pending
          ? {
              id: this.#pending.id,
              kind: this.#pending.kind,
              title: this.#pending.title,
              previous: this.#pending.previous,
              ...(this.#pending.variables ? { variables: this.#pending.variables } : {}),
              ...(this.#pending.showBranches !== undefined ? { showBranches: this.#pending.showBranches } : {}),
              ...(this.#pending.showComment !== undefined ? { showComment: this.#pending.showComment } : {}),
              ...(this.#pending.comment ? { comment: this.#pending.comment } : {}),
              ...(this.#pending.envs ? { envs: this.#pending.envs } : {}),
              ...(this.#pending.environment ? { environment: this.#pending.environment } : {}),
              ...(this.#pending.tier ? { tier: this.#pending.tier } : {}),
            }
          : null,
      })
      return
    }

    if (req.method === 'POST' && path === `${ROUTE_PREFIX}/branch/answer`) {
      const body = await readJson(req) as (ClientAnswer & { id?: string }) | null
      const pending = this.#pending
      if (!pending || !body || body.id !== pending.id) {
        sendJson(res, 409, { ok: false, error: '没有匹配的分支选择请求' })
        return
      }
      pending.resolve({
        selected: body.selected,
        custom: body.custom,
        envs: body.envs,
        comment: body.comment,
        cancelled: body.cancelled === true,
      })
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }
}

export { ROUTE_PREFIX }
