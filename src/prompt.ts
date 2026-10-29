/**
 * 多分支流水线的交互选择：通过 DSH 的 `ctx.userQuestions` seam 弹窗，
 * 让用户在一个问题里同时完成「移除上次分支」和「新增分支」。
 *
 * 这里只做「协议」和「解析」，不依赖具体 UI；UI 由
 * `@deepseek-ai/dsh-client-ui-user-questions` 之类的 client 插件提供。
 */
import type { PipelineVariable, PluginContext, ToolRunContext } from './types.js'

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  id: string
  header: string
  question: string
  options: QuestionOption[]
  multiSelect?: boolean
}

interface AskService {
  ask: (payload: { questions: Question[], agent?: unknown, signal?: AbortSignal }) => Promise<{
    answers?: Array<{ id?: string, selected?: string[], custom?: string }>
  }>
}

export interface BranchAnswer {
  selected?: string[]
  custom?: string
}

export interface BranchChoice {
  /** 最终要集成的分支（保留的 + 新增的，去重）。 */
  branches: string[]
  /** 从上次分支里保留的。 */
  kept: string[]
  /** 被移除的上次分支。 */
  removed: string[]
  /** 本次新增的（不在上次分支集里）。 */
  added: string[]
}

/**
 * 解析单个问题的答案：
 * - `selected` = 要移除的上次分支（不选 = 全部保留）；
 * - `custom`   = 新增分支（逗号/空格分隔，可留空）。
 */
export function parseBranchAnswer(
  previous: string[],
  answers: { branches?: BranchAnswer },
): BranchChoice {
  const removeSelected = (answers.branches?.selected ?? [])
    .map(branch => String(branch).trim())
    .filter(Boolean)
  const removed = previous.filter(branch => removeSelected.includes(branch))
  const kept = previous.filter(branch => !removed.includes(branch))

  const custom = String(answers.branches?.custom ?? '').trim()
  const typed = custom ? custom.split(/[,，、\s]+/).map(branch => branch.trim()).filter(Boolean) : []
  const added = [...new Set(typed)].filter(branch => !previous.includes(branch))
  const branches = [...new Set([...kept, ...added])]
  return {
    branches,
    kept,
    removed: previous.filter(branch => !branches.includes(branch)),
    added,
  }
}

/**
 * 自定义 client 弹窗的答案：`selected` = **保留**的分支（默认全选），`custom` = 新增。
 * 与通用 userQuestions 的「勾选 = 移除」语义相反，因为自定义组件可以默认全勾。
 */
export function parseKeepAnswer(
  previous: string[],
  answer: { selected?: string[], custom?: string },
): BranchChoice {
  const selected = new Set(
    (answer.selected ?? []).map(branch => String(branch).trim()).filter(Boolean),
  )
  const kept = previous.filter(branch => selected.has(branch))
  const custom = String(answer.custom ?? '').trim()
  const typed = custom ? custom.split(/[,，、\s]+/).map(branch => branch.trim()).filter(Boolean) : []
  const added = [...new Set(typed)].filter(branch => !previous.includes(branch))
  const branches = [...new Set([...kept, ...added])]
  return {
    branches,
    kept,
    removed: previous.filter(branch => !branches.includes(branch)),
    added,
  }
}

export interface AskBranchesOptions {
  title: string
  previous: string[]
  /** 环境展示名（test / prod…）与层级，仅用于展示。 */
  environment?: string
  tier?: string
  agent?: unknown
  signal?: AbortSignal
}

/**
 * 弹窗让用户增减分支（单问题）：
 * - 勾选 = 从本次**取消**对应的上次分支；不勾 = 保留（和网页端默认全选等价）；
 * - 下方输入框 = 新增分支（可留空）。
 * 服务不可用时抛错，让调用方退回 `branches` 参数。
 */
export async function askBranches(ctx: PluginContext, options: AskBranchesOptions): Promise<BranchChoice> {
  const service = ctx.get?.('userQuestions', false) as AskService | undefined
  if (!service?.ask) {
    throw new Error('当前环境没有可用的交互提问服务（ctx.userQuestions），请改用 branches 参数直接指定')
  }

  const response = await service.ask({
    questions: [
      {
        id: 'branches',
        header: `移除分支（勾选 = 取消）${options.environment ? ` · ${options.environment}` : ''}`,
        question: `${options.title}${options.environment ? `（${options.environment}）` : ''}：下面是上次已集成的分支。勾选 = 本次取消该分支；不勾 = 保留。需要新增请填在下方输入框（多个用逗号分隔，可留空）。`,
        options: options.previous.map(branch => ({
          label: branch,
          description: '勾选 = 本次取消这个分支',
        })),
        multiSelect: true,
      },
    ],
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  const answers = Array.isArray(response?.answers) ? response.answers : []
  const item = answers.find(answer => answer?.id === 'branches') ?? answers[0]
  const choice = parseBranchAnswer(options.previous, { branches: item })
  if (choice.branches.length === 0) {
    throw new Error('多分支流水线至少要有一个运行分支：上次分支被全部取消，且输入框没有新增。请保留至少一个，或新增至少一个分支。')
  }
  return choice
}

/** 给工具输出用的简短描述：保留/新增/移除。 */
export function describeChoice(choice: BranchChoice): string {
  const parts: string[] = []
  if (choice.kept.length > 0)
    parts.push(`保留 ${choice.kept.length} 条`)
  if (choice.added.length > 0)
    parts.push(`新增 ${choice.added.length} 条`)
  if (choice.removed.length > 0)
    parts.push(`移除 ${choice.removed.length} 条`)
  return parts.join('，') || '无变化'
}

/** 兼容 DSH 的 exec 上下文（有 agent/signal 就跑，没有就跳过）。 */
export function askContextFromExec(exec: ToolRunContext): { agent?: unknown, signal?: AbortSignal } {
  return {
    ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
    ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
  }
}

export interface RunConfigOptions {
  title: string
  /** 多分支流水线的上次分支；非多分支传空数组。 */
  previous: string[]
  /** 是否显示分支选择区。 */
  showBranches: boolean
  /** 运行变量定义（只读元数据，不含值）。 */
  variables: PipelineVariable[]
  /** 是否显示运行备注输入框。 */
  showComment: boolean
  environment?: string
  tier?: string
  agent?: unknown
  signal?: AbortSignal
}

export interface RunConfigChoice {
  /** 显示分支区时的最终分支集合。 */
  branches?: BranchChoice
  /** 只包含用户真的填了值的变量（空串/未知 key 会被丢掉）。 */
  envs: Record<string, string>
  comment?: string
}

/** 解析「运行配置」弹窗答案：变量只认白名单 key，空值不覆盖（用平台默认值）。 */
export function parseRunConfigAnswer(
  options: Pick<RunConfigOptions, 'previous' | 'showBranches' | 'variables'>,
  answer: { selected?: string[], custom?: string, envs?: Record<string, unknown>, comment?: string },
): RunConfigChoice {
  const branches = options.showBranches
    ? parseKeepAnswer(options.previous, { selected: answer.selected, custom: answer.custom })
    : undefined
  if (branches && branches.branches.length === 0)
    throw new Error('多分支流水线至少要有一个运行分支：请至少保留一个，或在输入框里新增一个')

  const allowed = new Set(options.variables.map(variable => variable.key))
  const envs: Record<string, string> = {}
  for (const [key, value] of Object.entries(answer.envs ?? {})) {
    if (!allowed.has(key))
      continue
    const text = String(value ?? '').trim()
    if (text)
      envs[key] = text
  }
  const comment = String(answer.comment ?? '').trim()
  return {
    ...(branches ? { branches } : {}),
    envs,
    ...(comment ? { comment } : {}),
  }
}
