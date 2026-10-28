/**
 * 共享类型：流水线配置、运行记录、工具契约。
 *
 * 这些类型同时给运行时和 d.ts 使用者看，改字段时先想清楚是否破坏兼容。
 */

export type PipelineType = 'shell' | 'yunxiao'

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'lost'

/**
 * 环境的固定层级（对齐 GitLab deployment_tier）。
 * 只用于展示/分组/徽章，不参与执行与拦截。
 */
export type EnvironmentTier = 'development' | 'testing' | 'staging' | 'production' | 'other'

export type EnvMap = Record<string, string | undefined>

/**
 * 云效流水线的运行变量定义（只有元数据）。
 *
 * 平台详情接口会返回 `value`（可能是明文密钥），这里**故意不映射 value**：
 * 变量值永远不进工具输出、日志、通知或运行记录，只做触发时的显式覆盖。
 */
export interface PipelineVariable {
  key: string
  description?: string
  /** 运行时可配置（云效运行弹窗里会显示）。 */
  runningConfig?: boolean
  /** 加密变量：只展示「已配置」，值不可读。 */
  encrypted?: boolean
  /** 掩码变量：只展示「已配置」，值不可读。 */
  masked?: boolean
}

export interface PipelineBase {
  name: string
  type: PipelineType
  title: string
  description: string
  confirm: boolean
  timeoutSec: number
  cwd: string
  env: Record<string, string>
  /** 展示名：test / uat / prod / gray…（自由文本，可空）。 */
  environment?: string
  /** 固定层级，默认 other；只影响展示。 */
  tier?: EnvironmentTier
}

export interface ShellPipeline extends PipelineBase {
  type: 'shell'
  command: string
}

export interface YunxiaoPipeline extends PipelineBase {
  type: 'yunxiao'
  baseUrl: string
  organizationId: string
  pipelineId: string
  tokenEnv: string
  params: Record<string, unknown>
  triggerPath?: string
  statusPath?: string
  /**
   * 多分支模式（pipelineConfig.sources[].data.isBranchMode）的处理方式：
   * - append（默认）：上次运行的分支 + 本次新增
   * - replace：只用本次指定的分支
   * - off：完全不处理，按普通 params 透传
   */
  branchMode?: 'append' | 'replace' | 'off'
}

export type Pipeline
  = | ShellPipeline
    | YunxiaoPipeline

export interface ConfigDefaults {
  timeoutSec: number
  logTailLines: number
  maxConcurrent: number
}

export interface PipelineConfig {
  version: number
  path: string
  defaults: ConfigDefaults
  pipelines: Record<string, Pipeline>
}

export interface Project {
  root: string
  configPath: string
  runsDir: string
  config: PipelineConfig
  env: EnvMap
}

/** 一次运行的落盘记录（`.dsh/cicd-runs/<runId>.json`）。 */
export interface RunRecord {
  runId: string
  pipeline: string
  title: string
  type: PipelineType
  status: RunStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  params?: Record<string, unknown>
  projectRoot?: string
  serverPid?: number
  pid?: number
  logFile?: string
  externalId?: string
  url?: string
  note?: string
  rawStatus?: string
  progress?: string
  checkedAt?: string
  checkError?: string
  checkErrorRetryable?: boolean
  exitCode?: number | null
  buildUrl?: string
  /** 云效多分支模式：本次集成/运行的分支列表。 */
  branches?: string[]
  /** 云效运行变量副本（只有 key/描述/标记，不含值）；触发时写入，供后续展示。 */
  variables?: PipelineVariable[]
  /** 是否通过 `cicd_cancel` 取消（用户主动取消）：watcher 保留终态 toast，但不再唤醒模型。 */
  canceledByUser?: boolean
  /** 触发时流水线的环境展示名/层级（元数据，用于展示）。 */
  environment?: string
  tier?: EnvironmentTier
}

export interface TriggerInput {
  params?: Record<string, unknown>
}

export interface TriggerResult {
  externalId: string
  url?: string
  note?: string
  /** 云效多分支模式：本次实际提交的分支列表。 */
  branches?: string[]
  /** 云效运行变量副本（只有元数据，不含值）。 */
  variables?: PipelineVariable[]
}

export interface PollResult {
  status: RunStatus
  url?: string
  rawStatus?: string
  note?: string
  progress?: string
  buildUrl?: string
  exitCode?: number
  /** 云效多分支模式：本次运行集成的分支。 */
  branches?: string[]
}

export interface LogOptions {
  tailLines?: number
  maxChars?: number
}

/** 每种平台适配器的统一接口。 */
export interface Provider {
  trigger: (input: TriggerInput) => Promise<TriggerResult>
  poll: (record: RunRecord) => Promise<PollResult>
  logs: (record: RunRecord, options?: LogOptions) => Promise<string>
  /** 只读：抓取分支管理器相关 job 的日志（用于冲突解析）；没有实现时回退 logs。 */
  conflictLogs?: (record: RunRecord) => Promise<string>
  /** 只读：流水线运行变量定义（只有元数据，不含值）；没有实现时返回空。 */
  variables?: () => Promise<PipelineVariable[]>
  cancel: (record: RunRecord) => Promise<{ note?: string }>
}

export type WaitAbortReason = '' | 'fatal' | 'gave-up'
export type BudgetSource = 'param' | 'history' | 'default'

export interface WaitMeta {
  polls: number
  elapsedMs: number
  timedOut: boolean
  abortReason: WaitAbortReason
  errorStreak: number
  budgetSec: number
  budgetSource: BudgetSource
  lastDurationMs: number
  lastError: string
}

export interface WaitResult {
  record: RunRecord
  meta: WaitMeta
}

/** `cicd_run followUp: true` 时，后台终态/冲突唤醒模型用的一条 user 角色消息。 */
export interface FollowUpMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text', text: string }>
  source: { kind: string }
}

/** 后台跟踪在关键节点回调给 `cicd_run`，由它决定是否唤醒模型。 */
export interface WatchHooks {
  /** 终态：succeeded / failed / canceled；hint 是失败日志里的冲突/取消提示。 */
  onTerminal?: (record: RunRecord, hint?: string) => void
  /** 分支集成检测到合并冲突、运行暂停（不是终态）。每次运行只回调一次。 */
  onConflict?: (record: RunRecord) => void
}

/** DSH Agent 句柄里插件用到的部分（`followup` 由 DSH 运行时提供，旧版本可能没有）。 */
export interface ToolAgent {
  session?: { header?: { cwd?: string } }
  followup?: (message: FollowUpMessage) => void
}

/** DSH 工具执行上下文（只用到 cwd / agent / signal）。 */
export interface ToolRunContext {
  agent?: ToolAgent
  signal?: AbortSignal
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'json'
  required?: boolean
  description?: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters?: Record<string, ToolParameter>
  output: unknown
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<{ text: string }>
}

export type DefineTool = (spec: ToolSpec) => ToolSpec

export interface PluginOptions {
  configFile?: string
  runsDir?: string
  /** 是否把流水线进度投喂给 dsh-pet 气泡；默认开启，`false` 关闭。 */
  pet?: boolean
  /** 多宠物时指定投喂的宠物 id；为空则自动 main / 第一个。 */
  petId?: string
}

/** Cordis 里用到的能力，用鸭子类型避免强依赖。 */
export interface PluginContext {
  effect?: (fn: () => () => void) => void
  logger?: { warn?: (message: string) => void }
  tools: { register: (tool: ToolSpec) => void }
  /** 可选服务查找（cordis）；非严格模式下不存在返回 undefined。 */
  get?: (name: string, strict?: boolean) => unknown
  /** 可选：等某个服务就绪后再执行回调（cordis 的 ctx.inject）。 */
  inject?: (deps: string[], callback: (scope: PluginContext) => void) => void
  /** 可选：skills 服务（测试/自定义 scope 会传）。 */
  skills?: { register: (skill: unknown) => () => void }
}
