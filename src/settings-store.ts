/**
 * 全局设置 / 组织 / 已知项目存储（都放在 `$DSH_HOME`，不写项目目录）。
 *
 * - cicd-settings.json：全局 token 引用、pet/toast、历史保留条数
 * - pipeline-orgs.json：组织元数据（名称、baseUrl）
 * - cicd-projects.json：用过的项目根（设置页“所有已知项目”）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export const DEFAULT_TOKEN_REF = 'YUNXIAO_TOKEN'
export const DEFAULT_HISTORY_LIMIT = 200

export interface GlobalSettings {
  tokenRef: string
  pet: boolean
  petId: string
  toast: boolean
  historyLimit: number
}

export interface OrganizationMeta {
  id: string
  name?: string
  baseUrl?: string
}

interface SettingsFile extends Partial<GlobalSettings> {
  projects?: string[]
  organizations?: Record<string, { name?: string, baseUrl?: string }>
}

function homeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settingsPath(): string {
  return join(homeDir(), 'cicd-settings.json')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function readFile(): SettingsFile {
  return readJson<SettingsFile>(settingsPath()) ?? {}
}

export function readGlobalSettings(): GlobalSettings {
  const raw = readFile()
  const historyLimit = Number(raw.historyLimit)
  return {
    tokenRef: String(raw.tokenRef || DEFAULT_TOKEN_REF),
    pet: raw.pet !== false,
    petId: String(raw.petId || ''),
    toast: raw.toast !== false,
    historyLimit: Number.isFinite(historyLimit)
      ? Math.min(Math.max(Math.round(historyLimit), 20), 500)
      : DEFAULT_HISTORY_LIMIT,
  }
}

export function writeGlobalSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  const current = readGlobalSettings()
  const next: GlobalSettings = {
    tokenRef: String(patch.tokenRef ?? current.tokenRef),
    pet: patch.pet ?? current.pet,
    petId: String(patch.petId ?? current.petId),
    toast: patch.toast ?? current.toast,
    historyLimit: Math.min(Math.max(Math.round(Number(patch.historyLimit ?? current.historyLimit)), 20), 500),
  }
  const raw = readFile()
  writeJson(settingsPath(), { ...raw, ...next })
  return next
}

export function listOrganizations(): OrganizationMeta[] {
  const raw = readFile().organizations ?? {}
  return Object.entries(raw).map(([id, value]) => ({
    id,
    ...(value?.name ? { name: String(value.name) } : {}),
    ...(value?.baseUrl ? { baseUrl: String(value.baseUrl) } : {}),
  }))
}

export function saveOrganization(org: OrganizationMeta): void {
  const raw = readFile()
  const organizations = { ...(raw.organizations ?? {}) }
  organizations[org.id] = {
    ...(org.name ? { name: org.name } : {}),
    ...(org.baseUrl ? { baseUrl: org.baseUrl } : {}),
  }
  writeJson(settingsPath(), { ...raw, organizations })
}

export function deleteOrganization(id: string): void {
  const raw = readFile()
  const organizations = { ...(raw.organizations ?? {}) }
  delete organizations[id]
  writeJson(settingsPath(), { ...raw, organizations })
}

export function listProjects(): string[] {
  const raw = readFile()
  return [...new Set((raw.projects ?? []).map(String).filter(Boolean))]
    .filter(root => existsSync(root))
    .slice(0, 100)
}

/** 记录项目根（best-effort；设置页据此列出“所有已知项目”）。 */
export function rememberProject(root: string): void {
  try {
    if (!root || !existsSync(root))
      return
    const raw = readFile()
    const projects = [...new Set([...(raw.projects ?? []).map(String), root])].slice(-100)
    if (projects.length === (raw.projects ?? []).length && projects.every((item, index) => item === raw.projects?.[index]))
      return
    writeJson(settingsPath(), { ...raw, projects })
  }
  catch {}
}
