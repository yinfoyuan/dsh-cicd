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

/** DSH 工具执行上下文（只用到 cwd / agent / signal）。 */
export interface ToolRunContext {
  agent?: { session?: { header?: { cwd?: string } } }
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
