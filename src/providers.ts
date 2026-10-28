import type {
  EnvMap,
  LogOptions,
  Pipeline,
  PipelineVariable,
  PollResult,
  Provider,
  RunRecord,
  RunStatus,
  TriggerInput,
  TriggerResult,
  YunxiaoPipeline,
} from './types.js'
/**
 * HTTP 类流水线适配器：目前只保留云效（Alibaba Cloud DevOps Flow）。
 *
 * 每个适配器实现四个动作（shell 由 runner.ts 自己处理）：
 *   trigger({ params })  -> { externalId, url, note }
 *   poll(record)         -> { status, url?, note?, progress? }
 *   logs(record, opts)   -> string
 *   cancel(record)       -> { note }
 *
 * 约定：状态只用 runner 认识的那几个值（running / succeeded / failed / canceled / lost），
 * 原始平台状态放 record.rawStatus，方便排查。
 */
import process from 'node:process'
import { TERMINAL } from './state.js'

interface YunxiaoJob {
  id?: string | number
  name?: string
  jobSign?: string
  status?: string
  result?: string
}

interface YunxiaoStage {
  name?: string
  stageInfo?: { status?: string, jobs?: YunxiaoJob[] }
}

interface YunxiaoRun {
  status?: string
  url?: string
  statusText?: string
  stages?: YunxiaoStage[]
  globalParams?: unknown[]
  object?: YunxiaoRun
  pipelineRunId?: string | number
  id?: string | number
}

interface YunxiaoPipelineDetail {
  pipelineConfig?: {
    sources?: Array<{ data?: { isBranchMode?: boolean } }>
    settings?: unknown
  }
  object?: YunxiaoRun
}

function runOf(data: unknown): YunxiaoRun {
  const value = data as YunxiaoRun
  return value?.object ?? value
}

const STATUS_MAP: Array<[RegExp, RunStatus]> = [
  [/^(success|succeeded|successful|passed|pass|ok|done|completed|successed)$/i, 'succeeded'],
  [/^(failed|failure|fail|error|errored|broken|unstable)$/i, 'failed'],
  [/^(canceled|cancelled|aborted|stopped|skipped|manual)$/i, 'canceled'],
  [/^(running|in_progress|pending|queued|created|waiting|scheduled|building)$/i, 'running'],
]

export function normalizeStatus(raw?: unknown): RunStatus {
  if (!raw)
    return 'running'
  const s = String(raw).trim()
  for (const [re, out] of STATUS_MAP) {
    if (re.test(s))
      return out
  }
  return 'running'
}

/**
 * 判断一个错误「重试有没有意义」：
 * - 网络错误 / 超时 / 429 / 5xx / 响应不是 JSON：可以重试；
 * - 400 / 401 / 403 / 404：配置或凭证问题，重试只会浪费时间。
 * 没有标记的未知错误按可重试处理（宁可多试一次，也别把偶发问题当永久失败）。
 */
export function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && typeof (error as { retryable?: unknown }).retryable === 'boolean') {
    return (error as { retryable: boolean }).retryable
  }
  return true
}

interface HttpError extends Error {
  httpStatus?: number
  retryable?: boolean
  cause?: unknown
}

function httpError(status: number, statusText: string, url: string, text: string): HttpError {
  const error: HttpError = new Error(
    `HTTP ${status} ${statusText} - ${url}\n${String(text).replace(/\s+/g, ' ').slice(0, 300)}`,
  )
  error.httpStatus = status
  error.retryable = status === 408 || status === 425 || status === 429 || status >= 500
  return error
}

async function fetchText(url: string, options: RequestInit = {}, timeoutMs = 20_000): Promise<{ res: Response, text: string }> {
  let res: Response
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (cause) {
    const error: HttpError = new Error(`请求失败（网络/超时）：${(cause as Error)?.message ?? cause} - ${url}`)
    error.retryable = true
    error.cause = cause
    throw error
  }
  const text = await res.text()
  if (!res.ok)
    throw httpError(res.status, res.statusText, url, text)
  return { res, text }
}

async function fetchJson(url: string, options: RequestInit = {}, timeoutMs = 20_000): Promise<{ res: Response, data: unknown }> {
  const { res, text } = await fetchText(url, options, timeoutMs)
  try {
    return { res, data: JSON.parse(text) }
  }
  catch {
    const error: HttpError = new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
    error.retryable = true
    throw error
  }
}

function tailText(text: string | null | undefined, lines = 120, maxChars = 20_000): string {
  const arr = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let out = arr.slice(Math.max(0, arr.length - lines)).join('\n')
  if (out.length > maxChars)
    out = `…（截断）\n${out.slice(-maxChars)}`
  return out.trim()
}

function tokenOf(pipeline: { tokenEnv: string }, env: EnvMap | undefined): string {
  const varName = pipeline.tokenEnv
  const token = varName ? env?.[varName] : ''
  if (!token) {
    throw new Error(
      `缺少访问令牌：环境变量 ${varName} 为空。`
      + `请在 设置 → 流水线配置 里设置 Token，或用进程环境变量 ${varName}=...（不再读取项目 .env）。`,
    )
  }
  return token
}

/* ------------------------------- 云效 Flow ------------------------------ */
const STAGE_DONE = new Set(['SUCCESS', 'SKIP', 'SKIPPED', 'IGNORED'])
const STAGE_FAIL = new Set(['FAIL', 'FAILED', 'ERROR'])

type StageState = 'pending' | 'running' | 'failed' | 'success'

/**
 * 从云效 run 详情里抽出「现在跑到哪个阶段」，给等待/状态输出用。
 * 阶段状态由它下面的 jobs 推断（云效 stage 本身常常没有 status 字段）。
 */
export function summarizeStages(run: unknown): string {
  const detail = run as YunxiaoRun
  const stages: YunxiaoStage[] = Array.isArray(detail?.stages) ? detail.stages : []
  if (stages.length === 0)
    return ''

  const list = stages.map((stage, index) => {
    const jobs: YunxiaoJob[] = Array.isArray(stage?.stageInfo?.jobs) ? stage.stageInfo.jobs : []
    const statuses: string[] = jobs.map(job => String(job?.status ?? '').toUpperCase()).filter(Boolean)
    const declared = String(stage?.stageInfo?.status ?? '').toUpperCase()
    let state: StageState = 'pending'
    if (STAGE_FAIL.has(declared) || statuses.some(s => STAGE_FAIL.has(s)))
      state = 'failed'
    else if (STAGE_DONE.has(declared) || (statuses.length > 0 && statuses.every(s => STAGE_DONE.has(s))))
      state = 'success'
    else if (declared === 'RUNNING' || statuses.some(s => !STAGE_DONE.has(s) && !STAGE_FAIL.has(s)))
      state = 'running'
    return { index, name: stage?.name ?? `阶段${index + 1}`, state }
  })

  const active = list.find(s => s.state === 'failed')
    ?? list.find(s => s.state === 'running')
    ?? list[list.length - 1]
  const label: Record<StageState, string> = { running: '运行中', failed: '失败', success: '成功', pending: '未开始' }
  return `阶段 ${active.index + 1}/${list.length} · ${active.name}（${label[active.state]}）`
}

/**
 * 云效分支管理器在合并冲突时会把 job 挂起，`result` 里带「合并冲突，请解决后继续」。
 * 返回提示文案（没有冲突返回空串），供 poll 写进 record.note、watcher 主动提示。
 */
export function pendingConflict(run: unknown): string {
  const detail = run as YunxiaoRun
  const stages: YunxiaoStage[] = Array.isArray(detail?.stages) ? detail.stages : []
  for (const stage of stages) {
    for (const job of stage?.stageInfo?.jobs ?? []) {
      const result = String(job?.result ?? '')
      if (/合并冲突|Merge conflicted|Conflict Resolved/i.test(result)) {
        return '合并冲突：请在云效解决冲突后点「Conflict Resolved」'
      }
    }
  }
  return ''
}

/**
 * 云效在用户取消后可能把 run 标成 FAIL，但 job result 里写着「用户已取消」。
 * 用这个把「取消」从普通失败里区分出来。
 */
export function canceledByUser(run: unknown): boolean {
  const detail = run as YunxiaoRun
  const stages: YunxiaoStage[] = Array.isArray(detail?.stages) ? detail.stages : []
  for (const stage of stages) {
    for (const job of stage?.stageInfo?.jobs ?? []) {
      if (/用户已取消|UserCanceled/i.test(String(job?.result ?? '')))
        return true
    }
  }
  return false
}

/* -------------------- 云效多分支模式（branch mode） -------------------- */

/** 从云效 run 详情的 globalParams 里取本次集成的分支列表（CI_SOURCE_BRANCHES）。 */
export function parseSourceBranches(globalParams: unknown): string[] {
  const list = Array.isArray(globalParams) ? globalParams as Array<{ key?: unknown, value?: unknown }> : []
  const item = list.find(param => param.key === 'CI_SOURCE_BRANCHES' && typeof param.value === 'string')
  if (!item)
    return []
  try {
    const parsed = JSON.parse(String(item.value))
    if (!Array.isArray(parsed))
      return []
    return [...new Set(parsed
      .map((branch: unknown) => String((branch as { CI_COMMIT_REF_NAME?: unknown })?.CI_COMMIT_REF_NAME ?? '').trim())
      .filter(Boolean))]
  }
  catch {
    return []
  }
}

/** 合并分支：append = 上次已集成的 + 本次新增；replace = 只用本次。 */
export function mergeBranches(
  previous: string[],
  requested: string[],
  mode: 'append' | 'replace',
): string[] {
  const clean = (list: string[]): string[] => [...new Set(list.map(branch => String(branch ?? '').trim()).filter(Boolean))]
  return clean(mode === 'replace' ? requested : [...previous, ...requested])
}

function requestedBranches(branches: unknown, branch: unknown): string[] {
  const list: string[] = []
  if (Array.isArray(branches))
    list.push(...branches.map(String))
  else if (typeof branches === 'string')
    list.push(branches)
  if (typeof branch === 'string')
    list.push(branch)
  return mergeBranches([], list, 'append')
}

export interface YunxiaoBranchState {
  /** 流水线是否开了多分支模式（sources[].data.isBranchMode）。 */
  isBranchMode: boolean
  /** 上一次运行集成的分支（CI_SOURCE_BRANCHES）；拿不到就是空数组。 */
  previous: string[]
}

export interface YunxiaoPipelineState extends YunxiaoBranchState {
  /** 运行变量副本（只有 key/描述/标记，值不读取）。 */
  variables: PipelineVariable[]
}

function toPipelineVariable(item: unknown): PipelineVariable | null {
  const entry = item as Record<string, unknown> | null
  const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
  if (!key)
    return null
  const variable: PipelineVariable = { key }
  if (typeof entry?.description === 'string' && entry.description)
    variable.description = entry.description
  if (entry?.runningConfig === true)
    variable.runningConfig = true
  if (entry?.encrypted === true)
    variable.encrypted = true
  if (entry?.masked === true)
    variable.masked = true
  return variable
}

/**
 * 只要运行变量定义：不读 `value`（可能是明文密钥），只保留 key/描述/加密标记。
 * 字段来自流水线详情 `pipelineConfig.settings.globalParams[]`。
 */
export function parsePipelineVariables(settings: unknown): PipelineVariable[] {
  let value: unknown = settings
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    }
    catch {
      return []
    }
  }
  const list = (value as { globalParams?: unknown } | undefined)?.globalParams
  if (!Array.isArray(list))
    return []
  return list
    .map(toPipelineVariable)
    .filter((item): item is PipelineVariable => item !== null)
}

function detailPath(pipeline: YunxiaoPipeline): string {
  const orgPath = pipeline.organizationId ? `/organizations/${pipeline.organizationId}` : ''
  return `/oapi/v1/flow${orgPath}/pipelines/${pipeline.pipelineId}`
}

/** 只读流水线详情里的运行变量；失败抛错，由调用方决定是否 best-effort。 */
async function readPipelineVariables(pipeline: YunxiaoPipeline, env: EnvMap): Promise<PipelineVariable[]> {
  const headers = { 'x-yunxiao-token': tokenOf(pipeline, env), 'content-type': 'application/json' }
  const { data } = await fetchJson(`${pipeline.baseUrl}${detailPath(pipeline)}`, { headers })
  return parsePipelineVariables((data as YunxiaoPipelineDetail)?.pipelineConfig?.settings)
}

/**
 * 读取云效流水线的分支模式 + 运行变量定义。
 * 交互式选择分支（`cicd_run interactive`）、触发时的 merge 和变量副本都用它。
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
export async function getYunxiaoPipelineState(pipeline: YunxiaoPipeline, env: EnvMap): Promise<YunxiaoPipelineState> {
  const base = pipeline.baseUrl
  const basePath = detailPath(pipeline)
  const headers = { 'x-yunxiao-token': tokenOf(pipeline, env), 'content-type': 'application/json' }

  const { data } = await fetchJson(`${base}${basePath}`, { headers })
  const detail = data as YunxiaoPipelineDetail
  const sources = Array.isArray(detail?.pipelineConfig?.sources) ? detail.pipelineConfig.sources : []
  const isBranchMode = sources.some(source => source?.data?.isBranchMode === true)
  const variables = parsePipelineVariables(detail?.pipelineConfig?.settings)

  let previous: string[] = []
  if (isBranchMode) {
    const readPrevious = (run: YunxiaoRun): string[] => parseSourceBranches((run?.object ?? run)?.globalParams)
    try {
      const latest = await fetchJson(`${base}${basePath}/runs/latestPipelineRun`, { headers })
      previous = readPrevious(runOf(latest.data))
    }
    catch {
      previous = []
    }

    // 最近一次可能是「分支集成前就失败/取消」的运行（没有 CI_SOURCE_BRANCHES），
    // 这时回看最近几条运行，尽量避免弹窗拿不到上次分支集。
    if (previous.length === 0) {
      try {
        const list = await fetchJson(`${base}${basePath}/runs?page=1&perPage=5`, { headers })
        const listData = list.data as YunxiaoRun[] | { object?: YunxiaoRun[] }
        const runs: YunxiaoRun[] = Array.isArray(listData) ? listData : (listData.object ?? [])
        for (const item of runs) {
          const id = String(item?.pipelineRunId ?? item?.id ?? '')
          if (!id)
            continue
          try {
            const detail2 = await fetchJson(`${base}${basePath}/runs/${id}`, { headers })
            const branches = readPrevious(runOf(detail2.data))
            if (branches.length > 0) {
              previous = branches
              break
            }
          }
          catch {}
        }
      }
      catch {}
    }
  }
  return { isBranchMode, previous, variables }
}

/** 兼容旧调用点：只要分支状态（不含变量）。 */
export async function getYunxiaoBranchState(pipeline: YunxiaoPipeline, env: EnvMap): Promise<YunxiaoBranchState> {
  const { isBranchMode, previous } = await getYunxiaoPipelineState(pipeline, env)
  return { isBranchMode, previous }
}

/**
 * 云效 OpenAPI（新版 /oapi/v1/flow）：
 * - 触发 POST .../runs，body 里的 params 是「JSON 字符串」；响应是**裸整数** runId
 *   params 支持 branchModeBranchs / envs / runningBranchs / runningTags /
 *   running*Artifacts / comment（见 CreatePipelineRun 文档）
 * - 状态 GET .../runs/{runId}，status ∈ RUNNING / SUCCESS / FAIL
 * - 日志 GET .../runs/{runId}/job/{jobId}/log，jobId 从 stages[].stageInfo.jobs[].id 取
 * - 取消 PUT .../runs/{runId}（注意是 PUT），返回裸布尔
 * 中心版路径含 /organizations/{orgId}；Region 版没有这一段。
 */
function yunxiao(pipeline: YunxiaoPipeline, env: EnvMap): Provider {
  const base = pipeline.baseUrl
  const orgPath = pipeline.organizationId ? `/organizations/${pipeline.organizationId}` : ''
  const basePath = `/oapi/v1/flow${orgPath}/pipelines/${pipeline.pipelineId}`
  const headers = (): Record<string, string> => ({ 'x-yunxiao-token': tokenOf(pipeline, env), 'content-type': 'application/json' })
  const triggerPath = pipeline.triggerPath || `${basePath}/runs`
  const runUrl = (id: string): string => {
    if (pipeline.statusPath) {
      return pipeline.statusPath.includes('{runId}')
        ? pipeline.statusPath.replace('{runId}', id)
        : pipeline.statusPath
    }
    return `${basePath}/runs/${id}`
  }

  return {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    async trigger({ params }: TriggerInput): Promise<TriggerResult> {
      const merged = { ...pipeline.params, ...(params ?? {}) } as Record<string, unknown>
      // branches / branch / branchMode 是我们自己的入参，不直接透给云效。
      const { branches: branchesRaw, branch: branchRaw, branchMode: branchModeRaw, ...rest } = merged
      let payload: Record<string, unknown> = merged
      let branches: string[] = []
      let variables: PipelineVariable[] = []
      let modeNote = ''

      if (pipeline.branchMode !== 'off') {
        const requested = requestedBranches(branchesRaw, branchRaw)
        const mode: 'append' | 'replace'
          = String(branchModeRaw ?? pipeline.branchMode ?? 'append').toLowerCase() === 'replace' ? 'replace' : 'append'

        let state: YunxiaoPipelineState | null = null
        let detectError = ''
        try {
          state = await getYunxiaoPipelineState(pipeline, env)
          variables = state.variables
        }
        catch (error) {
          detectError = (error as Error).message
        }

        if (detectError && (requested.length > 0 || pipeline.branchMode)) {
          throw new Error(`无法确认云效流水线是否多分支模式：${detectError}`)
        }

        if (state?.isBranchMode) {
          // 多分支模式：上次运行集成的分支（CI_SOURCE_BRANCHES）默认要带上，再合并本次新增。
          const previous = mode === 'append' ? state.previous : []
          const finalBranches = mergeBranches(previous, requested, mode)
          if (finalBranches.length === 0) {
            throw new Error('这是多分支模式流水线，但没有可运行的分支：请用 branches 指定，或先在页面跑一次以继承上次分支')
          }
          payload = { ...rest, branchModeBranchs: finalBranches }
          branches = finalBranches
          modeNote = `多分支模式（${mode === 'replace' ? '替换' : '追加'}）：${finalBranches.join('、')}`
        }
        else if (requested.length > 0) {
          throw new Error('这条云效流水线不是多分支模式，branches / branch 参数不适用')
        }
      }

      // branchMode: off 时不会走上面的详情请求；单独读一次变量定义，失败就忽略。
      if (pipeline.branchMode === 'off') {
        try {
          variables = await readPipelineVariables(pipeline, env)
        }
        catch {}
      }

      // 官方要求：唯一顶层字段 params，且值是 JSON 字符串（不是对象）。
      const body = Object.keys(payload).length > 0 ? { params: JSON.stringify(payload) } : {}
      const { text } = await fetchText(`${base}${triggerPath}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      })
      const raw = text.trim()
      let runId: unknown = raw
      if (!/^\d+$/.test(raw)) {
        try {
          const data = JSON.parse(raw)
          runId = data?.pipelineRunId ?? data?.object?.pipelineRunId ?? data?.id ?? data?.object?.id ?? ''
        }
        catch {
          runId = ''
        }
      }
      if (!runId)
        throw new Error(`云效已响应但没解析出运行 id：${raw.slice(0, 300)}`)
      return {
        externalId: String(runId),
        url: '',
        note: [
          modeNote,
          `云效 Flow run ${runId}（页面：https://devops.aliyun.com/flow/pipeline/${pipeline.pipelineId}）`,
        ].filter(Boolean).join('；'),
        branches: branches.length > 0 ? branches : undefined,
        variables: variables.length > 0 ? variables : undefined,
      }
    },
    async poll(record: RunRecord): Promise<PollResult> {
      const { data } = await fetchJson(`${base}${runUrl(record.externalId ?? '')}`, { headers: headers() })
      const obj = runOf(data)
      const status = normalizeStatus(obj?.status)
      return {
        // 取消可能被平台标成 FAIL：job result 写明「用户已取消」时按取消处理。
        status: status === 'failed' && canceledByUser(obj) ? 'canceled' : status,
        url: obj?.url ?? record.url,
        rawStatus: obj?.status,
        note: pendingConflict(obj) || obj?.statusText,
        progress: summarizeStages(obj),
        branches: parseSourceBranches(obj?.globalParams),
      }
    },
    async logs(record: RunRecord, { tailLines = 120, maxChars = 20_000 }: LogOptions = {}): Promise<string> {
      const { data } = await fetchJson(`${base}${runUrl(record.externalId ?? '')}`, { headers: headers() })
      const obj = runOf(data)
      const stages: YunxiaoStage[] = Array.isArray(obj.stages) ? obj.stages : []
      const jobs = stages.flatMap(stage => (stage?.stageInfo?.jobs ?? []).map(job => ({
        id: job?.id,
        name: job?.name ?? job?.jobSign ?? `job-${job?.id}`,
        status: job?.status,
      }))).filter(job => job.id)

      if (jobs.length === 0)
        return '这次运行还没有可读的任务（jobs 为空），请到云效运行页面查看。'

      const failed = jobs.filter(job => normalizeStatus(job.status) === 'failed')
      const picked = (failed.length > 0 ? failed : jobs).slice(-4)
      const chunks: string[] = []
      for (const job of picked) {
        try {
          const { data: logData } = await fetchJson(`${base}${basePath}/runs/${record.externalId}/job/${job.id}/log`, { headers: headers() })
          const content = typeof logData === 'string' ? logData : (logData as { content?: string } | null)?.content ?? ''
          chunks.push(`===== job ${job.name} (#${job.id}, ${job.status ?? '?'}) =====\n${tailText(content, 80, 8_000)}`)
        }
        catch (error) {
          chunks.push(`===== job ${job.name} (#${job.id}) =====\n(日志读取失败：${(error as Error).message})`)
        }
      }
      return tailText(chunks.join('\n\n'), tailLines, maxChars)
    },
    /** 冲突解析专用：优先抓「分支 / Git / merge」相关 job，避免日志截断丢掉冲突信息。 */
    async conflictLogs(record: RunRecord): Promise<string> {
      const { data } = await fetchJson(`${base}${runUrl(record.externalId ?? '')}`, { headers: headers() })
      const obj = runOf(data)
      const stages: YunxiaoStage[] = Array.isArray(obj.stages) ? obj.stages : []
      const jobs = stages.flatMap(stage => (stage?.stageInfo?.jobs ?? []).map(job => ({
        id: job?.id,
        name: job?.name ?? job?.jobSign ?? `job-${job?.id}`,
        status: job?.status,
      }))).filter(job => job.id)
      if (jobs.length === 0)
        return ''

      const preferred = jobs.filter(job => /分支|git|merge|conflict/i.test(String(job.name)))
      const picked = (preferred.length > 0 ? preferred : jobs).slice(0, 8)
      const chunks: string[] = []
      for (const job of picked) {
        try {
          const { data: logData } = await fetchJson(`${base}${basePath}/runs/${record.externalId}/job/${job.id}/log`, { headers: headers() })
          const content = typeof logData === 'string' ? logData : (logData as { content?: string } | null)?.content ?? ''
          chunks.push(`===== job ${job.name} (#${job.id}, ${job.status ?? '?'}) =====\n${tailText(content, 200, 12_000)}`)
        }
        catch (error) {
          chunks.push(`===== job ${job.name} (#${job.id}) =====\n(日志读取失败：${(error as Error).message})`)
        }
      }
      return chunks.join('\n\n')
    },
    /** 只读：运行变量定义（不含值）。 */
    async variables(): Promise<PipelineVariable[]> {
      return readPipelineVariables(pipeline, env)
    },
    async cancel(record: RunRecord): Promise<{ note?: string }> {
      const { text } = await fetchText(`${base}${runUrl(record.externalId ?? '')}`, {
        method: 'PUT',
        headers: headers(),
      })
      return { note: `云效返回：${text.trim().slice(0, 120)}` }
    },
  }
}

export function createProvider(pipeline: Pipeline, env: EnvMap = process.env): Provider {
  if (pipeline.type === 'yunxiao')
    return yunxiao(pipeline, env)
  throw new Error(`不支持的流水线类型：${pipeline.type}（目前只支持 shell / yunxiao）`)
}

export { tailText, TERMINAL }
