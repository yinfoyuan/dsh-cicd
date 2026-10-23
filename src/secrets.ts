import type { EnvMap } from './types.js'
/**
 * 每个项目的密钥来源。
 *
 * 读取顺序（后者覆盖前者）：
 *   1. `~/.dsh/.credentials.yaml` 的 `refs:`
 *   2. 进程环境变量 process.env
 *
 * 项目目录里的 `.env` / `.dsh/.env` **不再读取**，避免 token 明文散落在仓库目录。
 * 推荐在 设置 → 流水线配置 里写 DSH 凭据；CI/无界面场景用进程环境变量。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

interface CacheEntry {
  key: string
  env: EnvMap
}

const cache = new Map<string, CacheEntry>()

/** 只取 `.credentials.yaml` 里 `refs:` 这一段（避免依赖 YAML 库）。 */
export function parseCredentials(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  let inRefs = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true
      continue
    }
    if (!inRefs)
      continue
    if (/^\S/.test(raw)) {
      inRefs = false
      continue
    }
    const matched = raw.match(/^[ \t]+([A-Z_]\w*):(.*)$/i)
    if (!matched)
      continue
    let value = matched[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    if (value)
      out[matched[1]] = value
  }
  return out
}

function readIf(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

function fingerprint(files: string[]): string {
  return files.map((file) => {
    try {
      const st = statSync(file)
      return `${st.mtimeMs}:${st.size}`
    }
    catch {
      return '0'
    }
  }).join('|')
}

/** 合并出该项目可见的环境变量（已包含 process.env）。 */
export function loadEnv(projectRoot: string): EnvMap {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const credentialsPath = join(dshHome, '.credentials.yaml')
  const files = [credentialsPath]
  const key = fingerprint(files)

  const hit = cache.get(projectRoot)
  if (hit && hit.key === key)
    return hit.env

  const env: EnvMap = {
    ...parseCredentials(readIf(credentialsPath)),
    ...process.env,
  }
  cache.set(projectRoot, { key, env })
  return env
}

interface CredentialsLike {
  resolve?: (ref: string) => Promise<{ value?: string } | undefined>
  describe?: (refs: string[] | string) => Promise<unknown>
  set?: (ref: string, value: string) => Promise<void>
  unset?: (ref: string) => Promise<void>
}

interface CredentialsHost {
  get?: (name: string, strict?: boolean) => unknown
  credentials?: CredentialsLike
}

function credentialsOf(ctx: CredentialsHost | undefined): CredentialsLike | undefined {
  return (ctx?.get?.('credentials', false) ?? ctx?.credentials) as CredentialsLike | undefined
}

/**
 * 用 DSH 的 credential-reference seam（`ctx.credentials`）解析 `tokenEnv`。
 *
 * 每次操作都重新解析（seam 的语义：改凭据不需要重启）；服务不可用、未配置或
 * 解析报错时返回 undefined，调用方回退到本地 `~/.dsh/.credentials.yaml` / 进程环境变量。
 */
export async function resolveCredential(
  ctx: CredentialsHost | undefined,
  ref: string | undefined,
): Promise<string | undefined> {
  const name = String(ref ?? '').trim()
  if (!name)
    return undefined
  const credentials: CredentialsLike | undefined = ctx?.get?.('credentials', false) ?? ctx?.credentials
  if (!credentials?.resolve)
    return undefined
  try {
    const resolved = await credentials.resolve(name)
    const value = String(resolved?.value ?? '').trim()
    return value || undefined
  }
  catch {
    return undefined
  }
}

/** 只查状态，不返回 token 值（DSH credentials 的 describe 语义）。 */
export async function credentialConfigured(ctx: CredentialsHost | undefined, ref: string | undefined): Promise<boolean> {
  const name = String(ref ?? '').trim()
  if (!name)
    return false
  const credentials = credentialsOf(ctx)
  if (credentials?.describe) {
    try {
      const out = await credentials.describe([name])
      const map = out as Record<string, unknown> | undefined
      const info = map?.[name] ?? out
      if (info && typeof info === 'object' && 'configured' in info)
        return Boolean((info as { configured?: unknown }).configured)
      if (typeof info === 'boolean')
        return info
    }
    catch {}
  }
  return Boolean(await resolveCredential(ctx, name))
}

export async function setCredential(ctx: CredentialsHost | undefined, ref: string, value: string): Promise<void> {
  const name = String(ref ?? '').trim()
  if (!name)
    throw new Error('缺少凭据引用名')
  const credentials = credentialsOf(ctx)
  if (!credentials?.set)
    throw new Error('当前 DSH 不支持安全凭据写入（credentials.set 不可用）')
  await credentials.set(name, value)
}

export async function unsetCredential(ctx: CredentialsHost | undefined, ref: string): Promise<void> {
  const name = String(ref ?? '').trim()
  if (!name)
    return
  const credentials = credentialsOf(ctx)
  if (!credentials?.unset)
    throw new Error('当前 DSH 不支持安全凭据删除（credentials.unset 不可用）')
  await credentials.unset(name)
}
