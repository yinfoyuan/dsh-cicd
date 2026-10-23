import type {
  ConfigDefaults,
  EnvironmentTier,
  EnvMap,
  Pipeline,
  PipelineConfig,
  PipelineType,
} from './types.js'
/**
 * 读取并校验某个项目的 `.dsh/cicd.json`。
 *
 * - 按 mtime 缓存：改完配置立即生效，不用重启 DSH；
 * - 校验失败给能直接照做的中文错误；
 * - 字符串支持 `${ENV_NAME}` 展开，token 只写引用。
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

export class ConfigError extends Error {
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ConfigError'
    this.hint = hint
  }
}

interface CacheEntry {
  key: string
  value: PipelineConfig
}

/** configPath -> { key, value } */
const cache = new Map<string, CacheEntry>()

/** 递归展开 `${VAR}`；未定义的变量保留原文，交给具体 provider 报错。 */
export function expandEnv<T>(value: T, env: EnvMap = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_]\w*)\}/gi, (raw, name: string) => {
      const v = env[name]
      return v === undefined ? raw : v
    }) as T
  }
  if (Array.isArray(value))
    return value.map(item => expandEnv(item, env)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, env)
    return out as T
  }
  return value
}

const TYPE_ALIASES = new Map<string, PipelineType>([
  ['shell', 'shell'],
  ['cmd', 'shell'],
  ['command', 'shell'],
  ['local', 'shell'],
  ['yunxiao', 'yunxiao'],
  ['云效', 'yunxiao'],
  ['flow', 'yunxiao'],
  // 官方英文名是 Alibaba Cloud DevOps；yunxiao 是音译/配置短名。
  ['devops', 'yunxiao'],
  ['aliyun-devops', 'yunxiao'],
  ['alibaba-cloud-devops', 'yunxiao'],
])

function fail(name: string, message: string, hint?: string): never {
  throw new ConfigError(`流水线「${name}」配置有误：${message}`, hint)
}

function str(
  name: string,
  value: unknown,
  field: string,
  { required = false }: { required?: boolean } = {},
): string {
  if (value === undefined || value === null || value === '') {
    if (required)
      fail(name, `缺少 ${field}`, `在 .dsh/cicd.json 的 pipelines.${name} 里补上 "${field}"`)
    return ''
  }
  if (typeof value !== 'string')
    fail(name, `${field} 必须是字符串`, '')
  return value
}

function num(name: string, value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null)
    return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0)
    fail(name, `${field} 必须是非负数字`, '')
  return n
}

/** 从云效流水线链接里取 pipelineId（也接受直接给的纯数字）。 */
export function extractPipelineId(url?: string): string {
  if (!url || typeof url !== 'string')
    return ''
  const matched = url.match(/pipelines?\/(\d+)/i)
  if (matched)
    return matched[1]
  const trailing = url.match(/\/(\d+)(?:[/?#].*)?$/)
  return trailing ? trailing[1] : ''
}

/** 从链接里取 organizationId（如果有）。 */
export function extractOrganizationId(url?: string): string {
  if (!url || typeof url !== 'string')
    return ''
  const matched = url.match(/organizations?\/([A-Z0-9]+)/i)
  return matched ? matched[1] : ''
}

export interface LoadConfigOptions {
  fresh?: boolean
  env?: EnvMap
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
export function loadConfig(configPath: string, { fresh = false, env = process.env }: LoadConfigOptions = {}): PipelineConfig {
  const abs = resolve(configPath)

  let st
  try {
    st = statSync(abs)
  }
  catch {
    throw new ConfigError(
      `找不到流水线配置：${abs}`,
      '在项目根创建 `.dsh/cicd.json`（示例见 dsh-cicd 的 examples/）',
    )
  }

  const key = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(abs)
  if (!fresh && hit && hit.key === key)
    return hit.value

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'))
  }
  catch (error) {
    throw new ConfigError(`流水线配置不是合法 JSON：${abs}`, String(error?.message ?? error))
  }

  raw = expandEnv(raw, env)
  const parsed = raw as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('流水线配置根节点必须是对象', '')
  }

  const defaultsRaw = (parsed.defaults ?? {}) as Record<string, unknown>
  const defaults: ConfigDefaults = {
    timeoutSec: num('defaults', defaultsRaw.timeoutSec, 'defaults.timeoutSec', 900),
    logTailLines: num('defaults', defaultsRaw.logTailLines, 'defaults.logTailLines', 120),
    maxConcurrent: num('defaults', defaultsRaw.maxConcurrent, 'defaults.maxConcurrent', 4),
  }

  const pipelinesRaw = parsed.pipelines
  if (!pipelinesRaw || typeof pipelinesRaw !== 'object' || Array.isArray(pipelinesRaw)) {
    throw new ConfigError(
      '流水线配置缺少 pipelines 对象',
      '形如：{ "pipelines": { "build": { "type": "shell", "command": "pnpm build" } } }',
    )
  }

  const pipelines: Record<string, Pipeline> = {}
  for (const [rawName, rawBody] of Object.entries(pipelinesRaw as Record<string, unknown>)) {
    const body = rawBody as Record<string, unknown>
    const name = rawName.trim()
    if (!/^\w[\w.-]{0,47}$/.test(name)) {
      throw new ConfigError(
        `流水线名称不合法：${rawName}`,
        '只允许字母、数字、点、下划线、短横线，最长 48，且不能以符号开头',
      )
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      fail(name, '定义必须是对象', '')

    const type = TYPE_ALIASES.get(String(body.type ?? 'shell').toLowerCase())
    if (!type)
      fail(name, `不认识的 type：${body.type}`, '目前只支持 shell | yunxiao（别名 devops / flow / 云效）')

    const tierRaw = str(name, body.tier, 'tier').toLowerCase()
    if (tierRaw && !['development', 'testing', 'staging', 'production', 'other'].includes(tierRaw)) {
      fail(name, `tier 只能是 development / testing / staging / production / other`, '只影响展示，不影响执行')
    }
    const environment = str(name, body.environment, 'environment') || tierRaw

    const common = {
      name,
      title: str(name, body.title, 'title') || name,
      description: str(name, body.description, 'description'),
      confirm: body.confirm === true,
      timeoutSec: num(name, body.timeoutSec, 'timeoutSec', defaults.timeoutSec),
      cwd: str(name, body.cwd, 'cwd') || '.',
      env: body.env && typeof body.env === 'object'
        ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)]))
        : {},
      environment: environment || undefined,
      tier: (tierRaw || 'other') as EnvironmentTier,
    }

    if (type === 'shell') {
      pipelines[name] = {
        ...common,
        type: 'shell',
        command: str(name, body.command, 'command', { required: true }),
      }
    }
    else {
      // yunxiao：目前除 shell 外只保留云效
      // 允许直接粘贴流水线链接：从链接里取 pipelineId（和能取到的 organizationId）。
      const pipelineId = String(body.pipelineId ?? '').trim() || extractPipelineId(typeof body.url === 'string' ? body.url : undefined)
      const branchMode = str(name, body.branchMode, 'branchMode').toLowerCase()
      if (branchMode && !['append', 'replace', 'off'].includes(branchMode)) {
        fail(name, `branchMode 只能是 append / replace / off`, '多分支流水线默认 append：上次运行分支 + 本次新增')
      }
      const baseUrl = (str(name, body.baseUrl, 'baseUrl') || 'https://openapi-rdc.aliyuncs.com').replace(/\/+$/, '')
      const organizationId = str(name, body.organizationId, 'organizationId') || extractOrganizationId(typeof body.url === 'string' ? body.url : undefined)
      if (!organizationId && baseUrl === 'https://openapi-rdc.aliyuncs.com') {
        fail(
          name,
          '缺少 organizationId（中心版云效必须填）',
          '从带 /organizations/<orgId>/ 的链接里取，或直接问用户「这条流水线在哪个云效组织下？」；Region 版可自定义 baseUrl 后留空',
        )
      }
      pipelines[name] = {
        ...common,
        type: 'yunxiao',
        baseUrl,
        // 中心版需要 organizationId；Region 版没有这一段，留空即可。
        organizationId,
        pipelineId: pipelineId || fail(name, '缺少 pipelineId', '在配置里写 pipelineId，或直接把云效流水线链接粘到 "url"'),
        tokenEnv: str(name, body.tokenEnv, 'tokenEnv') || 'YUNXIAO_TOKEN',
        params: body.params && typeof body.params === 'object' ? body.params as Record<string, unknown> : {},
        triggerPath: str(name, body.triggerPath, 'triggerPath') || undefined,
        statusPath: str(name, body.statusPath, 'statusPath') || undefined,
        branchMode: branchMode
          ? (branchMode as 'append' | 'replace' | 'off')
          : undefined,
      }
    }
  }

  if (Object.keys(pipelines).length === 0) {
    throw new ConfigError('pipelines 里一个流水线都没有', '至少配置一个，例如 ping')
  }

  const value: PipelineConfig = { version: Number(parsed.version ?? 1), defaults, pipelines, path: abs }
  cache.set(abs, { key, value })
  return value
}
