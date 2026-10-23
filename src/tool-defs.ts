import type { PetNotifier } from './pet.js'
import type { AskBranchesOptions, BranchChoice } from './prompt.js'
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
  WaitMeta,
} from './types.js'
/**
 * 六个模型工具的声明与执行体。
 *
 * 单独放一个模块（而不是塞进 index.ts）的原因：这里不 import
 * `@deepseek-ai/dsh-tools`，测试可以传一个假的 defineTool 进来，
 * 直接跑完整的工具逻辑，不需要 DSH 运行时。
 */
import { join } from 'node:path'
import { ConfigError } from './config.js'
import { environmentLabel, ICON, pipelineSummaryLine, recordText } from './format.js'
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

export interface BuildToolDeps {
  defineTool: DefineTool
  runner: Runner
  options: PluginOptions
  /** 可选：把等待结果投喂给 dsh-pet 气泡（不在时静默跳过）。 */
  notify?: PetNotifier
  /** 插件上下文（交互式提问用）；测试可不传。 */
  ctx?: PluginContext
  /** 读取云效分支状态；默认走真实 API，测试可注入。 */
  branchState?: (pipeline: Pipeline, env: Record<string, string | undefined>) => Promise<YunxiaoBranchState>
  /** 交互式选择分支；默认走 ctx.userQuestions，测试或自定义 client 可注入。 */
  branchDialog?: (options: AskBranchesOptions) => Promise<BranchChoice>
  /** 等待结束后推一条 client toast（自定义 UI，best-effort）。 */
  notice?: (record: RunRecord, meta: WaitMeta) => void
  /** 触发后开始后台跟踪（阶段变化/结束主动提示），不阻塞对话。 */
  watch?: (project: Project, record: RunRecord) => void
  /** 某个 run 是否还在后台跟踪（用于把 cicd_wait 默认改成非阻塞）。 */
  isWatching?: (runId: string) => boolean
}

export function buildToolDefinitions({ defineTool, runner, options, notify: _notify, ctx, branchState, branchDialog, notice: _notice, watch, isWatching }: BuildToolDeps): ToolSpec[] {
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
            '跟踪：cicd_status / cicd_wait / cicd_logs',
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
    name: 'cicd_run',
    description: '触发当前项目配置的一条流水线，立即返回 runId（异步，不阻塞）。触发后自动开启后台跟踪：阶段变化/结束会通过 toast 提示，用户可以继续对话，不需要一直 cicd_wait。云效多分支模式：**默认一定弹窗确认分支**；只有显式传 branches，或用户明确说「沿用上次分支」时才传 reusePrevious:true 跳过弹窗。interactive:false 不再跳过（兼容旧参数，等价默认弹窗）。标记 🔒 的流水线会真的执行，必须先征得用户明确同意，再带 confirm:true 调用。',
    parameters: {
      pipeline: { type: 'string', required: true, description: '流水线名称（先用 cicd_list 查看）' },
      params: { type: 'json', description: '传给平台的参数（分支、环境等），可省略' },
      branches: { type: 'json', description: '云效多分支模式：本次要新增/替换的运行分支列表，如 ["feature/login"]；显式传了才会跳过弹窗' },
      branchMode: { type: 'string', description: '多分支模式处理方式：append（默认，上次 + 本次）或 replace（只用本次）' },
      reusePrevious: { type: 'boolean', description: '仅当用户**明确说**「沿用上次分支 / 用上次的分支集」时传 true：跳过弹窗，直接用上次确认的集合（replace）' },
      interactive: { type: 'boolean', description: '已弃用：默认就是弹窗；传 false 也不会跳过（只有 reusePrevious:true 才跳过）' },
      preview: { type: 'boolean', description: '配合弹窗：只选择分支并返回结果，不真正触发' },
      confirm: { type: 'boolean', description: '对标记 confirm:true 的流水线，在用户确认后传 true' },
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
        else if (explicit || auto) {
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
        watch?.(project, record)
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
            '',
            `后台跟踪中：阶段变化/结束会通过 toast 提示，可以继续做别的事。`,
            `❌ 不要自动调用 cicd_wait；只有用户明确说「等它跑完」时才用 cicd_wait { "runId": "${record.runId}", "block": true }。`,
            `查当前状态用 cicd_status（不阻塞）。`,
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
    description: '查询某次运行的状态；不传 runId 时查该流水线最近一次。HTTP 类流水线会实时回源查询平台状态。',
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
    name: 'cicd_wait',
    description: '查看一次运行的状态（**不阻塞、不等待**）。运行结束会由后台跟踪通知；不要用本工具跟踪运行，也不要在 cicd_run 之后自动调用。',
    parameters: {
      runId: { type: 'string', required: true, description: '运行 id' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolRunContext) {
      try {
        const project = resolveProject(exec, options)
        const current = await runner.status(project, { runId: String(args.runId ?? '') })
        const watching = isWatching?.(current.runId) === true
        return {
          text: [
            `${ICON[current.status] ?? '•'} ${current.pipeline} · ${current.status}`,
            current.progress ? `progress: ${current.progress}` : '',
            current.note ? `note:    ${current.note}` : '',
            '',
            current.status !== 'running'
              ? '这次运行已经结束。'
              : watching
                ? '后台跟踪中：阶段变化/结束会通过 toast 提示，可以继续做别的事。'
                : '当前没有后台跟踪（可能已结束或插件重启过）；查状态用 cicd_status。',
            '本工具只查一次状态，不会等待。',
          ].filter(Boolean).join('\n'),
        }
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
