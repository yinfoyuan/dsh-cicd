import type { PluginOptions, Project, ToolRunContext } from './types.js'
/**
 * 从工具执行上下文解析「当前项目」。
 *
 * DSH 的工具执行上下文带着调用它的 agent；`agent.session.header.cwd` 就是会话的
 * 工作目录（也就是项目根）。项目级配置全部相对它解析。
 */
import { resolve } from 'node:path'
import { ConfigError, loadConfig } from './config.js'
import { loadEnv } from './secrets.js'
import { rememberProject } from './settings-store.js'

export function resolveProject(exec: ToolRunContext | undefined, options: PluginOptions = {}): Project {
  const cwd = exec?.agent?.session?.header?.cwd
  if (!cwd || typeof cwd !== 'string') {
    throw new ConfigError(
      '无法确定当前会话的项目目录（exec.agent.session.header.cwd 为空）',
      '这些工具只能在某个项目的会话里使用；没有项目目录就没有 .dsh/cicd.json 可读。',
    )
  }

  const root = resolve(cwd)
  rememberProject(root)
  const configPath = resolve(root, options.configFile ?? '.dsh/cicd.json')
  const runsDir = resolve(root, options.runsDir ?? '.dsh/cicd-runs')
  const env = loadEnv(root)
  const config = loadConfig(configPath, { env })
  return { root, configPath, runsDir, config, env }
}
