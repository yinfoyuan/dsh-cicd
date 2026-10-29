import type { AskBranchesOptions, BranchChoice, RunConfigChoice, RunConfigOptions } from './prompt.js'
import type { YunxiaoBranchState } from './providers.js'
import type { Runner } from './runner.js'
import type {
  DefineTool,
  Pipeline,
  PluginContext,
  PluginOptions,
  Project,
  RunRecord,
  ToolRunContext,
  ToolSpec,
  WatchHooks,
} from './types.js'
/**
 * 七个模型工具的声明与执行体。
 *
 * 单独放一个模块（而不是塞进 index.ts）的原因：这里不 import
 * `@deepseek-ai/dsh-tools`，测试可以传一个假的 defineTool 进来，
 * 直接跑完整的工具逻辑，不需要 DSH 运行时。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ConfigError } from './config.js'
import { conflictWakeText, environmentLabel, followUpText, ICON, pipelineSummaryLine, recordText, waitingWakeText } from './format.js'
import { resolveProject } from './project.js'
import { askBranches, describeChoice } from './prompt.js'
import { getYunxiaoBranchState } from './providers.js'
import {
  ConfirmRequired,
  PipelineError,

} from './runner.js'
import { latestRecord, readBranchSelection, saveBranchSelection } from './state.js'

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
}

function errorText(error: unknown): string {
  if (error instanceof ConfigError) {
    return `❌ 流水线配置错误：${error.message}${error.hint ? `\n提示：${error.hint}` : ''}`
  }
  if (error instanceof PipelineError) {
    return `❌ ${error.message}${error.hint ? `\n提示：${error.hint}` : ''}`
  }
  return `❌ 执行失败：${(error as Error)?.message ?? String(error)}`
}

function missingConfigText(projectRoot: string): string {
  const configPath = join(projectRoot, '.dsh', 'cicd.json')
  return [
    `本项目还没有流水线配置。`,
    ``,
    `创建文件：${configPath}`,
    ``,
    '最小示例（流水线已经在平台上建好，只需要 ID）：',
    '```json',
    '{',
    '  "pipelines": {',
    '    "deploy-test": {',
    '      "type": "yunxiao",',
    '      "title": "部署测试环境",',
    '      "organizationId": "<组织ID>",',
    '      "pipelineId": "<流水线ID>",',
    '      "tokenEnv": "YUNXIAO_TOKEN"',
    '    }',
    '  }',
    '}',
    '```',
    `配置改完立即生效，不用重启。token 用设置页配置 DSH 凭据，或进程环境变量；不要写项目 .env。`,
  ].join('\n')
}

/**
 * 云效运行参数：把工具入参映射成 `CreatePipelineRun` 的 `params` key。
 * 形状见官方文档：`params` 是 JSON 字符串，支持
 * `branchModeBranchs / envs / runningBranchs / runningTags / running*Artifacts / comment`。
 *
 * 只做「整体覆盖」：`envs`、`tags`、`artifacts` 都是整对象替换，不做深合并。
 */
const ARTIFACT_KEYS = {
  pipeline: 'runningPipelineArtifacts',
  acr: 'runningAcrArtifacts',
  packages: 'runningPackagesArtifacts',
} as const

/** 平台要的是 `{ key: "value" }`：值统一转字符串，嵌套对象直接报错。 */
function stringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} 必须是对象，例如 { "key": "value" }`)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'object')
      throw new Error(`${field}.${key} 必须是字符串、数字或布尔值`)
    out[key] = String(item)
  }
  return out
}

function artifactsParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('artifacts 必须是对象，例如 { "pipeline": { "<pipelineId>": "12" } }')
  const out: Record<string, unknown> = {}
  for (const [kind, item] of Object.entries(value)) {
    if (!(kind in ARTIFACT_KEYS))
      throw new Error(`artifacts 只支持 pipeline / acr / packages，收到了「${kind}」`)
    if (item !== undefined)
      out[ARTIFACT_KEYS[kind as keyof typeof ARTIFACT_KEYS]] = stringMap(item, `artifacts.${kind}`)
  }
  return out
}

function yunxiaoRunParams(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (args.comment !== undefined) {
    if (typeof args.comment !== 'string')
      throw new Error('comment 必须是字符串（运行备注）')
    out.comment = args.comment
  }
  if (args.envs !== undefined)
    out.envs = stringMap(args.envs, 'envs')
  if (args.tags !== undefined)
    out.runningTags = stringMap(args.tags, 'tags')
  if (args.repoBranches !== undefined)
    out.runningBranchs = stringMap(args.repoBranches, 'repoBranches')
  if (args.artifacts !== undefined)
    Object.assign(out, artifactsParams(args.artifacts))
  return out
}

export interface BuildToolDeps {
  defineTool: DefineTool
  runner: Runner
  options: PluginOptions
  /** 插件上下文（交互式提问用）；测试可不传。 */
  ctx?: PluginContext
  /** 读取云效分支状态；默认走真实 API，测试可注入。 */
  branchState?: (pipeline: Pipeline, env: Record<string, string | undefined>) => Promise<YunxiaoBranchState>
  /** 交互式选择分支；默认走 ctx.userQuestions，测试或自定义 client 可注入。 */
  branchDialog?: (options: AskBranchesOptions) => Promise<BranchChoice>
  /** 「运行配置」弹窗（分支 + 变量 + 备注）；client 不在线时返回 undefined，由工具决定回退。 */
  runDialog?: (options: RunConfigOptions) => Promise<RunConfigChoice> | undefined
  /** 触发后开始后台跟踪（阶段变化/结束主动提示），不阻塞对话。 */
  watch?: (project: Project, record: RunRecord, hooks?: WatchHooks) => void
}

export function buildToolDefinitions({ defineTool, runner, options, ctx, branchState, branchDialog, runDialog, watch }: BuildToolDeps): ToolSpec[] {
  const tools: ToolSpec[] = []

  tools.push(defineTool({
    name: 'cicd_list',
    description: '列出当前项目 .dsh/cicd.json 里配置的流水线：名称、类型、说明、最近一次运行。触发前先用这个确认名称。',
    parameters: {},
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const lines = Object.values(project.config.pipelines)
          .map((p: Pipeline) => pipelineSummaryLine(p, latestRecord(project.runsDir, p.name)))
        return {
          text: [
            `项目：${project.root}`,
            `配置：${project.configPath}`,
            `流水线：${lines.length} 条`,
            '',
            ...lines,
            '',
            '触发：cicd_run { "pipeline": "<名称>" }',
            '查状态：cicd_status · 读日志：cicd_logs',
            '修改配置后立即生效，不用重启。',
          ].join('\n'),
        }
      }
      catch (error) {
        if (error instanceof ConfigError && /找不到流水线配置/.test(error.message)) {
          const root = exec?.agent?.session?.header?.cwd
          if (root)
            return { text: missingConfigText(root) }
        }
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_vars',
    description: '只读：列出云效流水线的运行变量（名称/描述/是否加密），**不读取变量值**。触发前用它确认有哪些变量可以覆盖；覆盖值用 cicd_run 的 envs 传，没传的用平台默认值。shell 流水线没有运行变量。',
    parameters: {
      pipeline: { type: 'string', required: true, description: '流水线名称（先用 cicd_list 查看）' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const name = String(args.pipeline ?? '')
        const variables = await runner.variables(project, { pipeline: name })
        if (variables.length === 0)
          return { text: `流水线「${name}」没有运行变量（平台未返回变量定义，或这不是云效流水线）。` }

        const lines = variables.map((item) => {
          const secret = item.encrypted || item.masked ? '（已配置，值不可读）' : ''
          const desc = item.description ? `：${item.description}` : ''
          return `- ${item.key}${secret}${desc}`
        })
        return {
          text: [
            `流水线「${name}」的运行变量（只读，值不会读取）：${variables.length} 个`,
            ...lines,
            '',
            '覆盖某个变量：cicd_run { "pipeline": "...", "envs": { "<key>": "<value>" } }；没传的用平台默认值。',
          ].join('\n'),
        }
      }
      catch (error) {
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_run',
    description: '触发当前项目配置的一条流水线，立即返回 runId（异步，不阻塞）。**触发后本轮任务就结束了**：直接回复用户已触发，阶段变化/结束由后台 toast 通知；不要用 Start-Sleep / 循环 cicd_status 等方式等待结果。如果用户的诉求不只是「触发」，而是要在运行结束后继续处理（如部署、分析失败、汇报结果），或要关注运行中的合并冲突、等待人工确认、异常，传 followUp:true，终态或检测到冲突/人工确认暂停时会自动唤醒你继续。云效多分支模式：**默认一定弹窗确认分支**；只有显式传 branches，或用户明确要求复用上次运行的分支集合时才传 reusePrevious:true 跳过弹窗。interactive:false 不再跳过（兼容旧参数，等价默认弹窗）。云效运行参数：comment（运行备注）、envs（运行变量）、tags（按仓库地址的运行 tag）、repoBranches（按仓库地址的运行分支）、artifacts（流水线/ACR/制品包版本），与 params 合并、命名参数优先。只想知道有哪些运行变量（不读取值）时用 cicd_vars；覆盖时用 envs，没传的用平台默认值。配置了 runConfig 的流水线每次触发前会弹「运行配置」（分支 + 变量 + 备注），空着 = 用云效默认值；用户话里如果有版本、环境、目的、变更说明、工单号这类上下文，主动提取成 comment 传进来（例如「预发布版本」），不要等用户专门提备注；用户明确表示这次不改运行变量时传 runConfig:false，只跳过变量/备注，分支确认仍会弹（除非 reusePrevious）。标记 🔒 的流水线会真的执行，必须先征得用户明确同意，再带 confirm:true 调用。',
    parameters: {
      pipeline: { type: 'string', required: true, description: '流水线名称（先用 cicd_list 查看）' },
      params: { type: 'json', description: '传给平台的参数（分支、环境等），可省略' },
      comment: { type: 'string', description: '云效运行备注。把用户话里值得记录且有助于回溯这次运行的上下文原话带上（版本、环境、目的、变更说明、工单号等，例如「预发布版本」）；运行配置弹窗会预填，用户可再改' },
      envs: { type: 'json', description: '云效运行变量，如 { "APP_ENV": "test" }；值支持字符串/数字/布尔' },
      tags: { type: 'json', description: '云效按仓库地址指定的运行 tag，如 { "https://codeup.aliyun.com/<org>/<repo>.git": "1.0" }' },
      repoBranches: { type: 'json', description: '云效按仓库地址指定的运行分支（runningBranchs）；多分支模式的集合用 branches，不要用它' },
      artifacts: { type: 'json', description: '云效制品版本：{ "pipeline": { "<pipelineId>": "12" }, "acr": { "<registry>/<image>": "<tag>" }, "packages": { "<package>": "<version>" } }' },
      branches: { type: 'json', description: '云效多分支模式：本次要新增/替换的运行分支列表，如 ["feature/login"]；只在用户明确给出分支或要求替换时传。开启 runConfig 的流水线里它只是弹窗预选，不会跳过确认' },
      branchMode: { type: 'string', description: '多分支模式处理方式：append（默认，上次 + 本次）或 replace（只用本次）' },
      reusePrevious: { type: 'boolean', description: '当用户明确要求复用上次运行的分支集合（不是本次重新挑选）时传 true：跳过弹窗，直接用上次确认的集合（replace）' },
      interactive: { type: 'boolean', description: '已弃用：默认就是弹窗；传 false 也不会跳过（只有 reusePrevious:true 才跳过）' },
      runConfig: { type: 'boolean', description: '触发前是否弹「运行配置」弹窗（分支 + 运行变量 + 备注）：默认按流水线配置 runConfig；用户明确表示这次不改运行变量时传 false，只跳过变量/备注，分支确认仍会弹（除非 reusePrevious）；需要强制确认时传 true' },
      preview: { type: 'boolean', description: '配合弹窗：只选择分支并返回结果，不真正触发' },
      confirm: { type: 'boolean', description: '对标记 confirm:true 的流水线，在用户确认后传 true' },
      followUp: { type: 'boolean', description: '当用户的诉求超出「触发」时传 true：包括运行结束后继续处理（部署/回滚/分析失败/汇报）或关注运行中的合并冲突、异常。只触发、没有后续诉求时不要传，也不要为了等结果传' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const rawParams = args.params
        const params: Record<string, unknown> = rawParams && typeof rawParams === 'object' ? { ...rawParams as Record<string, unknown> } : {}
        const pipelineName = String(args.pipeline ?? '')
        if (args.branches !== undefined)
          params.branches = args.branches
        if (args.branchMode !== undefined)
          params.branchMode = args.branchMode

        const pipeline = project.config.pipelines[pipelineName]
        const reuse = args.reusePrevious === true
        const explicit = args.interactive === true
        const auto = !reuse
          && args.branches === undefined
          && params.branches === undefined
          && params.branch === undefined
          && pipeline?.type === 'yunxiao'
          && pipeline?.branchMode !== 'off'

        // 云效一等运行参数：与 params 合并，命名参数优先（整体覆盖，不做深合并）。
        const yunxiaoParams = yunxiaoRunParams(args)
        if (Object.keys(yunxiaoParams).length > 0) {
          if (!pipeline || pipeline.type !== 'yunxiao')
            throw new Error('comment / envs / tags / repoBranches / artifacts 只支持云效（yunxiao）流水线')
          Object.assign(params, yunxiaoParams)
        }

        const runConfigArg = args.runConfig
        if (runConfigArg !== undefined && typeof runConfigArg !== 'boolean')
          throw new Error('runConfig 必须是 boolean')
        if (runConfigArg === true && (!pipeline || pipeline.type !== 'yunxiao'))
          throw new Error('runConfig 只支持云效（yunxiao）流水线')

        // 配置开启（或强制 true）时每次触发都确认；runConfig:false 只跳过变量/备注，
        // 分支确认仍然要弹（除非 reusePrevious 明确复用）。
        const runConfigConfigured = pipeline?.type === 'yunxiao'
          && (runConfigArg === true || pipeline.runConfig === true)
        const skipVariables = runConfigArg === false
        let runConfigWarning = ''

        if (reuse) {
          if (!pipeline || pipeline.type !== 'yunxiao') {
            throw new Error('reusePrevious 只支持云效（yunxiao）多分支流水线')
          }
          const state = await (branchState ?? getYunxiaoBranchState)(pipeline, project.env)
          if (!state.isBranchMode)
            throw new Error('这条云效流水线不是多分支模式，不能用 reusePrevious')
          const saved = readBranchSelection(project.root, pipeline.name)
          const previous = saved?.selected.length ? saved.selected : state.previous
          if (previous.length === 0) {
            throw new PipelineError(
              '没有可沿用的上次分支记录',
              '请先弹窗确认一次分支，或显式传 branches。',
            )
          }
          params.branches = previous
          params.branchMode = 'replace'
        }

        if (runConfigConfigured && pipeline) {
          try {
            const variables = skipVariables ? [] : await runner.variables(project, { pipeline: pipelineName })
            let state: YunxiaoBranchState | null = null
            if (!reuse && pipeline.branchMode !== 'off')
              state = await (branchState ?? getYunxiaoBranchState)(pipeline, project.env)

            const showBranches = !reuse && state?.isBranchMode === true
            const saved = readBranchSelection(project.root, pipeline.name)
            const candidates = [...new Set([...(state?.previous ?? []), ...(saved?.selected ?? [])])]
            const selected = candidates.filter(branch => !(saved?.removed ?? []).includes(branch))
            // 开了 runConfig 的流水线：显式 branches 只做弹窗预选，不再跳过确认。
            const branchInput = args.branches !== undefined ? args.branches : params.branches
            const requested = Array.isArray(branchInput)
              ? branchInput.map(branch => String(branch).trim()).filter(Boolean)
              : typeof branchInput === 'string' ? [branchInput.trim()].filter(Boolean) : []
            const previous = [...new Set(requested.length > 0 ? requested : selected)]

            const needDialog = showBranches || !skipVariables
            const initialComment = typeof args.comment === 'string'
              ? args.comment.trim()
              : typeof params.comment === 'string' ? params.comment.trim() : ''
            const dialogOptions: RunConfigOptions = {
              title: pipeline.title || pipeline.name,
              previous,
              showBranches,
              variables,
              showComment: !skipVariables,
              ...(initialComment ? { comment: initialComment } : {}),
              ...(pipeline.environment ? { environment: pipeline.environment } : {}),
              ...(pipeline.tier ? { tier: pipeline.tier } : {}),
              agent: exec?.agent,
              signal: exec?.signal,
            }

            let choice: RunConfigChoice = { envs: {} }
            if (needDialog) {
              const pending = runDialog?.(dialogOptions)
              if (pending) {
                choice = await pending
              }
              else {
                // client 未加载：分支回退到通用提问；变量不弹，全部用云效默认值。
                const branches = showBranches
                  ? await (branchDialog ?? ((opts: AskBranchesOptions) => askBranches(ctx!, opts)))(dialogOptions)
                  : undefined
                choice = { ...(branches ? { branches } : {}), envs: {} }
                if (!skipVariables)
                  runConfigWarning = '运行配置弹窗不可用（client 未加载）：本次未修改变量，使用云效默认值'
              }
            }

            if (choice.branches) {
              const finalBranches = choice.branches.branches
              params.branches = finalBranches
              params.branchMode = 'replace'
              // 和独立分支弹窗一致：记住选中/移除，下次默认 = 云效分支 ∪ 选中 − 移除。
              const removedNow = previous.filter(branch => !finalBranches.includes(branch))
              const removed = [...new Set([...(saved?.removed ?? []), ...removedNow])]
                .filter(branch => !finalBranches.includes(branch))
              saveBranchSelection(project.root, pipeline.name, finalBranches, removed)
            }
            if (Object.keys(choice.envs).length > 0)
              params.envs = choice.envs
            if (choice.comment !== undefined) {
              if (choice.comment)
                params.comment = choice.comment
              else
                delete params.comment
            }

            if (args.preview === true) {
              return {
                text: [
                  `已确认运行配置：${pipeline.title || pipeline.name}`,
                  choice.branches ? `分支：${choice.branches.branches.join('、')}` : '',
                  Object.keys(choice.envs).length > 0
                    ? `变量覆盖：${Object.keys(choice.envs).join('、')}（值不回显）`
                    : '变量覆盖：无（使用云效当前值）',
                  choice.comment ? `备注：${choice.comment}` : '',
                  runConfigWarning ? `⚠️ ${runConfigWarning}` : '',
                  '',
                  'preview 模式：没有触发运行。去掉 preview 再调用一次即可真正执行。',
                ].filter(Boolean).join('\n'),
              }
            }
          }
          catch (error) {
            const message = (error as Error)?.message ?? String(error)
            if (/取消/.test(message))
              throw error
            throw new PipelineError(
              `运行配置未完成，已取消触发：${message}`,
              '请重试；或直接用 envs / branches 参数指定本次覆盖',
            )
          }
        }
        else if (!reuse && (explicit || auto)) {
          if (!pipeline) {
            throw new PipelineError(
              `没有名为「${pipelineName}」的流水线。已配置：${Object.keys(project.config.pipelines).join('、')}`,
              `配置在 ${project.configPath}`,
            )
          }
          if (pipeline.type !== 'yunxiao') {
            if (explicit)
              throw new Error('interactive 只支持云效（yunxiao）流水线')
          }
          else if (pipeline.branchMode === 'off') {
            if (explicit)
              throw new Error('这条流水线配置了 branchMode: off，不支持交互选择分支')
          }
          else {
            try {
              if (!ctx && explicit)
                throw new Error('插件上下文不可用，无法弹出选择框；请改用 branches 参数')
              const state = await (branchState ?? getYunxiaoBranchState)(pipeline, project.env)
              if (!state.isBranchMode) {
                if (explicit)
                  throw new Error('这条云效流水线不是多分支模式（isBranchMode=false），不需要选择分支')
              }
              else {
                // 本地记忆只做「过滤」：云效上次分支 ∪ 本地选中 − 本地明确移除。
                // 这样别人在云效新加的分支仍会出现，用户取消过的分支不会复活。
                const saved = readBranchSelection(project.root, pipeline.name)
                const candidates = [...new Set([...state.previous, ...(saved?.selected ?? [])])]
                const previous = candidates.filter(branch => !(saved?.removed ?? []).includes(branch))
                if (previous.length === 0 && explicit) {
                  throw new Error('没有上次运行的分支记录，无法做增减；请直接用 branches 指定本次分支')
                }
                const ask = branchDialog ?? ((opts: AskBranchesOptions) => askBranches(ctx!, opts))
                const choice = await ask({
                  title: pipeline.title || pipeline.name,
                  previous,
                  ...(pipeline.environment ? { environment: pipeline.environment } : {}),
                  ...(pipeline.tier ? { tier: pipeline.tier } : {}),
                  agent: exec?.agent,
                  signal: exec?.signal,
                })
                if (args.preview === true) {
                  return {
                    text: [
                      `已选择分支：${choice.branches.join('、')}`,
                      `变化：${describeChoice(choice)}`,
                      `上次分支：${state.previous.join('、')}`,
                      '',
                      'preview 模式：没有触发运行。去掉 preview 再调用一次即可真正执行。',
                    ].join('\n'),
                  }
                }
                // 用户已经给了最终集合，用 replace 保证被取消勾选的分支不会被 append 加回来。
                params.branches = choice.branches
                params.branchMode = 'replace'
                // 记住「选中」和「本次取消的」，下次用 云效分支 ∪ 选中 − 移除 计算默认值。
                const removedNow = previous.filter(branch => !choice.branches.includes(branch))
                const removed = [...new Set([...(saved?.removed ?? []), ...removedNow])]
                  .filter(branch => !choice.branches.includes(branch))
                saveBranchSelection(project.root, pipeline.name, choice.branches, removed)
              }
            }
            catch (error) {
              const message = (error as Error)?.message ?? String(error)
              if (/取消/.test(message))
                throw error
              throw new PipelineError(
                `分支选择框不可用，已取消触发：${message}`,
                '请重试；或直接用 branches 指定本次分支（会跳过弹窗）',
              )
            }
          }
        }

        const record: RunRecord = await runner.run(project, pipelineName, {
          params,
          confirm: args.confirm === true,
        })
        const followUpRequested = args.followUp === true
        const canFollowUp = followUpRequested && typeof exec.agent?.followup === 'function'
        const wake = (text: string): void => {
          try {
            exec.agent?.followup?.({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'dsh-cicd' },
            })
          }
          catch {}
        }
        const hooks: WatchHooks | undefined = canFollowUp
          ? {
              onTerminal: (final, hint) => wake(followUpText(final, hint)),
              onConflict: final => wake(conflictWakeText(final)),
              onWaiting: final => wake(waitingWakeText(final)),
            }
          : undefined
        watch?.(project, record, hooks)
        const env = environmentLabel(record)
        return {
          text: [
            `${ICON[record.status] ?? '•'} 已触发 ${record.pipeline}（${record.type}）`,
            `runId:  ${record.runId}`,
            `status: ${record.status}`,
            env ? `environment: ${env.slice(1, -1)}` : '',
            record.branches?.length ? `branches: ${record.branches.join('、')}` : '',
            record.url ? `url:    ${record.url}` : '',
            record.note ? `note:   ${record.note}` : '',
            record.overriddenVariables?.length
              ? `变量覆盖：${record.overriddenVariables.join('、')}（只显示名称，值不回显）`
              : record.variables?.length
                ? `运行变量：${record.variables.length} 个（未覆盖，使用平台默认值；查看用 cicd_vars）`
                : '',
            runConfigWarning ? `⚠️ ${runConfigWarning}` : '',
            '',
            `✅ 触发完成，本轮到此结束。`,
            canFollowUp
              ? `用户要求继续跟进这次运行：终态、检测到合并冲突或等待人工确认时会自动唤醒你，现在直接回复用户已触发、你会继续跟进，并结束本轮。`
              : followUpRequested
                ? `⚠️ 当前 DSH 不支持自动唤醒；结束后请让用户再问，或用户自己用 cicd_status 查看。`
                : `请直接回复用户：已触发 ${record.pipeline}（runId: ${record.runId}），后台跟踪中，阶段变化/结束会通知。`,
            `⚠️ 不要等待：不要用 Start-Sleep、循环 cicd_status 或任何方式等它跑完；结果会由后台 toast 通知。`,
            `用户之后主动问进度时再用 cicd_status（只查一次，不阻塞）。`,
            record.type === 'shell' ? `日志：cicd_logs { "runId": "${record.runId}" }` : '',
          ].filter(Boolean).join('\n'),
        }
      }
      catch (error) {
        if (error instanceof ConfirmRequired) {
          const pipeline = error.pipeline
          throw new Error(
            `⚠️ ${error.message}\n这条流水线会真的执行「${pipeline.title}」${pipeline.description ? `（${pipeline.description}）` : ''}。\n`
            + '请先把要执行的内容告诉用户并得到明确同意，然后再调用一次并带上 "confirm": true。',
          )
        }
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_status',
    description: '查询某次运行的状态，只查一次、不阻塞、不等待；不传 runId 时查该流水线最近一次。HTTP 类流水线会实时回源查询平台状态；在等人工确认（例如人工卡点）时输出会带 waiting。不要在 cicd_run 之后循环调用它等结果（结束会由后台 toast 通知）。',
    parameters: {
      runId: { type: 'string', description: 'cicd_run 返回的运行 id' },
      pipeline: { type: 'string', description: '不传 runId 时，用流水线名查最近一次' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const record = await runner.status(project, { ...(typeof args.runId === 'string' ? { runId: args.runId } : {}), ...(typeof args.pipeline === 'string' ? { pipeline: args.pipeline } : {}) })
        return { text: recordText(record) }
      }
      catch (error) {
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_logs',
    description: '读取一次运行的日志尾部（有行数和字符上限，不会灌爆上下文）。失败时先看这里。',
    parameters: {
      runId: { type: 'string', required: true, description: '运行 id' },
      tailLines: { type: 'number', description: '取最后多少行，默认按项目配置' },
      maxChars: { type: 'number', description: '输出字符上限，默认 20000' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const text = await runner.logs(project, { ...(typeof args.runId === 'string' ? { runId: args.runId } : {}), ...(typeof args.tailLines === 'number' ? { tailLines: args.tailLines } : {}), ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}) })
        return { text }
      }
      catch (error) {
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_conflict',
    description: '只读：读取云效多分支运行的合并冲突信息（冲突文件、release/feature 分支、日志尾部），用于和用户一起解决。不会自动合并，也不会让流水线继续。',
    parameters: {
      runId: { type: 'string', required: true, description: '运行 id' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const { record, info } = await runner.conflict(project, { runId: String(args.runId ?? '') })
        if (!info.hasConflict) {
          return {
            text: [
              `✅ ${record.pipeline} 未检测到合并冲突`,
              `status:  ${record.status}`,
              record.progress ? `progress: ${record.progress}` : '',
              record.note ? `note:    ${record.note}` : '',
              '',
              '可能还没到分支集成阶段，或冲突已解决。需要完整日志用 cicd_logs。',
            ].filter(Boolean).join('\n'),
          }
        }

        const lines = [
          `⚠️ ${record.pipeline} 检测到合并冲突`,
          `runId:   ${record.runId}`,
          record.externalId ? `云效 run: ${record.externalId}` : '',
          `status:  ${record.status}${info.paused ? '（job 已暂停，等待人工合并）' : ''}`,
          record.progress ? `progress: ${record.progress}` : '',
          '',
          info.conflictFiles.length > 0 ? '冲突文件:' : '',
          ...info.conflictFiles.map(file => `  - ${file}`),
          info.releaseBranch || info.baseBranch || info.featureBranches.length > 0 ? '分支:' : '',
          info.baseBranch ? `  base:    ${info.baseBranch}` : '',
          info.releaseBranch ? `  release: ${info.releaseBranch}` : '',
          info.featureBranches.length > 0 ? `  feature: ${info.featureBranches.join('、')}` : '',
          info.conflictBranch ? `  conflict: ${info.conflictBranch}` : '',
          info.repoUrl ? `仓库: ${info.repoUrl}` : '',
          '',
          '说明：插件不会自动合并，也不会自动让流水线继续。',
          '请和用户确认合并方案，在 release 分支解决冲突并推送后，由用户在云效页面点「Conflict Resolved」。',
          '解决后后台跟踪会继续通知；本工具只读取信息。',
          info.logTail ? ['', '日志片段:', info.logTail.slice(-6_000)] : '',
        ]
        return { text: lines.flat().filter(Boolean).join('\n') }
      }
      catch (error) {
        throw new Error(errorText(error))
      }
    },
  }))

  tools.push(defineTool({
    name: 'cicd_cancel',
    description: '取消一次运行（本地 shell 会结束整个进程树；平台类流水线调用平台的取消接口）。',
    parameters: {
      runId: { type: 'string', required: true, description: '运行 id' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const record = await runner.cancel(project, { runId: typeof args.runId === 'string' ? args.runId : undefined })
        return { text: recordText(record) }
      }
      catch (error) {
        throw new Error(errorText(error))
      }
    },
  }))

  return tools
}
