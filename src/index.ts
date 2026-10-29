import type { AskBranchesOptions, BranchChoice, RunConfigChoice, RunConfigOptions } from './prompt.js'
import type { DefineTool, PluginContext, PluginOptions, ToolSpec } from './types.js'
/**
 * dsh-cicd：每个项目自己的 CI 流水线。
 *
 * 插件本身全局安装一次；每个项目在 `<项目根>/.dsh/cicd.json` 声明自己的
 * 流水线（平台 + ID + token 环境变量）。工具按调用会话的
 * `agent.session.header.cwd` 找项目根，所以同一个 DSH 进程里不同项目的会话
 * 各自看到各自的流水线。
 *
 * 注册的工具：
 *   cicd_list / cicd_run / cicd_status / cicd_logs / cicd_conflict / cicd_cancel
 *
 * @module dsh-cicd
 */
import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools'
import { BranchBroker } from './branch-broker.js'
import { ConfigService } from './config-service.js'
import { createPetNotifier } from './pet.js'
import { askBranches } from './prompt.js'
import { Runner } from './runner.js'
import { readGlobalSettings } from './settings-store.js'
import { registerCicdSkill } from './skill.js'
import { buildToolDefinitions } from './tool-defs.js'
import { RunWatcher } from './watcher.js'

/** DSH 的 defineTool 类型比插件内部契约更宽（schema 系统不同），这里收窄成自己的 ToolSpec。 */
// eslint-disable-next-line slop/no-chained-type-assertions -- 两套类型体系不同，只能先 unknown 再收窄
const defineTool = dshDefineTool as unknown as DefineTool

/** Cordis 插件名。 */
export const name = 'cicd'

/** 需要的服务：工具注册表。 */
export const inject = ['tools']

export function apply(ctx: PluginContext, config: PluginOptions = {}): void {
  const runner = new Runner(ctx)
  ctx.effect?.(() => () => runner.dispose())

  const options: PluginOptions = {
    configFile: config.configFile ?? '.dsh/cicd.json',
    runsDir: config.runsDir ?? '.dsh/cicd-runs',
    pet: config.pet !== false,
    ...(config.petId ? { petId: config.petId } : {}),
  }

  // 桌宠提示是可选的：dsh-pet 没装时 notifier 静默返回 false，不影响任何工具。
  const notify = options.pet ? createPetNotifier(ctx, options.petId) : undefined

  // 内置 skill：模型可以用 `cicd-config` 引导生成/修改流水线配置。
  registerCicdSkill(ctx)

  // 多分支选择优先用插件自己的 client 弹窗（默认全选、贴合 DSH 主题）；
  // client 未加载时回退到通用 userQuestions。
  const branchBroker = new BranchBroker(ctx)
  const configService = new ConfigService(ctx)
  branchBroker.attachConfig(configService)
  // webServer 可能比插件稍晚就绪：等它出现再注册路由（否则 /dsh-cicd/* 会 404）。
  if (ctx.inject)
    ctx.inject(['webServer'], () => { branchBroker.registerRoutes() })
  else branchBroker.registerRoutes()
  ctx.effect?.(() => () => branchBroker.dispose())
  const branchDialog = (dialogOptions: AskBranchesOptions): Promise<BranchChoice> =>
    branchBroker.hasClient() ? branchBroker.ask(dialogOptions) : askBranches(ctx, dialogOptions)
  // 运行配置弹窗：client 不在线时返回 undefined，由 tool-defs 决定回退（分支走 userQuestions，变量用默认值）。
  const runDialog = (dialogOptions: RunConfigOptions): Promise<RunConfigChoice> | undefined =>
    branchBroker.hasClient() ? branchBroker.askRunConfig(dialogOptions) : undefined

  // 触发后的后台跟踪：阶段变化/结束主动提示，不阻塞对话。
  const watcher = new RunWatcher(runner, {
    notice: (text, project, runId) => {
      branchBroker.notify(text, 'info', project, runId)
      if (notify && readGlobalSettings().pet)
        void notify.say(text).catch(() => {})
    },
  })
  ctx.effect?.(() => () => watcher.dispose())

  let tools: ToolSpec[]
  try {
    tools = buildToolDefinitions({
      defineTool,
      runner,
      options,
      ctx,
      branchDialog,
      runDialog,
      watch: (project, record, hooks) => watcher.watch(project, record, hooks),
      muteWaiting: runId => watcher.muteWaiting(runId),
    })
  }
  catch (error) {
    ctx.logger?.warn?.(`pipeline: 构建工具定义失败：${(error as Error)?.message ?? error}`)
    return
  }

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    }
    catch (error) {
      // 单个工具重名不应该让整套工具消失
      ctx.logger?.warn?.(`pipeline: 注册 ${tool.name} 失败（可能被别的插件占用）：${(error as Error)?.message ?? error}`)
    }
  }
}
