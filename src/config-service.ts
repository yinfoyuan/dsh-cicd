import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GlobalSettings, OrganizationMeta } from './settings-store.js'
import type { PluginContext } from './types.js'
/**
 * 设置页的配置 API（只读 + 本地编辑）。
 *
 * 所有路由挂在 `/dsh-cicd/config` 下，由 BranchBroker 的同一 webServer 前缀转发。
 * 只操作本插件的本地数据：项目 `.dsh/cicd.json`、`$DSH_HOME` 下的组织/偏好/token 引用。
 * 不会触发或修改云效上的流水线。
 */
import { Buffer } from 'node:buffer'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { loadConfig } from './config.js'
import { listPets, petDebug } from './pet.js'
import { credentialConfigured, loadEnv, setCredential, unsetCredential } from './secrets.js'
import {
  deleteOrganization,

  listOrganizations,
  listProjects,

  readGlobalSettings,
  rememberProject,
  saveOrganization,
  writeGlobalSettings,
} from './settings-store.js'
import { latestRecord } from './state.js'

const ALLOWED_PIPELINE_FIELDS = [
  'type',
  'title',
  'organizationId',
  'pipelineId',
  'environment',
  'tier',
  'confirm',
  'branchMode',
  'command',
  'url',
  'baseUrl',
  'params',
] as const

interface ConfigResponse {
  prefs: GlobalSettings
  token: { ref: string, configured: boolean }
  organizations: OrganizationMeta[]
  pets: Array<{ id: string, name?: string }>
  projects: Array<{
    root: string
    configPath: string
    error?: string
    pipelines: Array<Record<string, unknown>>
  }>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0)
    return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

interface PipelineView {
  type?: string
  title?: string
  organizationId?: string
  pipelineId?: string
  environment?: string
  tier?: string
  confirm?: boolean
  branchMode?: string
  command?: string
}

function pipelineSummary(rawName: string, pipeline: Record<string, unknown>, root: string): Record<string, unknown> {
  const text = (key: string): string | undefined => (typeof pipeline[key] === 'string' ? pipeline[key] as string : undefined)
  const entry: PipelineView = {
    type: text('type'),
    title: text('title'),
    organizationId: text('organizationId'),
    pipelineId: text('pipelineId'),
    environment: text('environment'),
    tier: text('tier'),
    branchMode: text('branchMode'),
    command: text('command'),
    confirm: pipeline.confirm === true,
  }
  const latest = latestRecord(join(root, '.dsh', 'cicd-runs'), rawName)
  return {
    name: rawName,
    type: entry.type,
    title: entry.title,
    ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
    ...(entry.pipelineId ? { pipelineId: entry.pipelineId } : {}),
    ...(entry.environment ? { environment: entry.environment } : {}),
    ...(entry.tier ? { tier: entry.tier } : {}),
    confirm: entry.confirm === true,
    ...(entry.branchMode ? { branchMode: entry.branchMode } : {}),
    ...(entry.type === 'shell' ? { command: entry.command } : {}),
    ...(latest
      ? {
          latest: {
            runId: latest.runId,
            status: latest.status,
            startedAt: latest.startedAt,
            durationMs: latest.durationMs,
          },
        }
      : {}),
  }
}

function cleanPipeline(input: unknown): Record<string, unknown> {
  const source = (input ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ALLOWED_PIPELINE_FIELDS) {
    if (source[key] !== undefined)
      out[key] = source[key]
  }
  return out
}

export class ConfigService {
  #ctx: PluginContext

  constructor(ctx: PluginContext) {
    this.#ctx = ctx
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    const prefix = '/dsh-cicd/config'
    if (!pathname.startsWith(prefix))
      return false

    try {
      if (req.method === 'GET' && pathname === prefix) {
        sendJson(res, 200, await this.#snapshot())
        return true
      }

      if (req.method === 'GET' && pathname === `${prefix}/pet-debug`) {
        sendJson(res, 200, petDebug())
        return true
      }

      if (req.method === 'GET' && pathname === `${prefix}/prefs`) {
        sendJson(res, 200, readGlobalSettings())
        return true
      }

      if (req.method === 'PUT' && pathname === `${prefix}/pipeline`) {
        const body = await readJsonBody(req)
        if (!body)
          return this.#bad(res, '请求体不是合法 JSON')
        sendJson(res, 200, await this.#savePipeline(body))
        return true
      }

      if (req.method === 'DELETE' && pathname === `${prefix}/pipeline`) {
        const root = url.searchParams.get('projectRoot') ?? ''
        const name = url.searchParams.get('name') ?? ''
        sendJson(res, 200, await this.#deletePipeline(root, name))
        return true
      }

      if (req.method === 'PUT' && pathname === `${prefix}/organization`) {
        const body = await readJsonBody(req)
        if (!body)
          return this.#bad(res, '请求体不是合法 JSON')
        sendJson(res, 200, this.#saveOrg(body))
        return true
      }

      if (req.method === 'DELETE' && pathname === `${prefix}/organization`) {
        sendJson(res, 200, this.#deleteOrg(url.searchParams.get('id') ?? ''))
        return true
      }

      if (req.method === 'POST' && pathname === `${prefix}/token`) {
        const body = await readJsonBody(req)
        const value = String(body?.value ?? '')
        if (!value)
          return this.#bad(res, 'token 不能为空')
        const ref = readGlobalSettings().tokenRef
        await setCredential(this.#ctx, ref, value)
        sendJson(res, 200, { ok: true, ref, configured: true })
        return true
      }

      if (req.method === 'DELETE' && pathname === `${prefix}/token`) {
        const ref = readGlobalSettings().tokenRef
        await unsetCredential(this.#ctx, ref)
        sendJson(res, 200, { ok: true, ref, configured: false })
        return true
      }

      if (req.method === 'PUT' && pathname === `${prefix}/prefs`) {
        const body = await readJsonBody(req)
        if (!body)
          return this.#bad(res, '请求体不是合法 JSON')
        sendJson(res, 200, { ok: true, prefs: writeGlobalSettings(body) })
        return true
      }

      sendJson(res, 404, { ok: false, error: '未知的配置接口' })
      return true
    }
    catch (error) {
      sendJson(res, 400, { ok: false, error: (error as Error)?.message ?? String(error) })
      return true
    }
  }

  #bad(res: ServerResponse, error: string): true {
    sendJson(res, 400, { ok: false, error })
    return true
  }

  async #snapshot(): Promise<ConfigResponse> {
    const prefs = readGlobalSettings()
    const tokenConfigured = await credentialConfigured(this.#ctx, prefs.tokenRef)
    const pets = await listPets(this.#ctx)
    const projects = listProjects().map((root) => {
      const configPath = join(root, '.dsh', 'cicd.json')
      try {
        const config = loadConfig(configPath, { env: loadEnv(root) })
        return {
          root,
          configPath,
          pipelines: Object.entries(config.pipelines).map(([name, pipeline]) => pipelineSummary(name, { ...pipeline }, root)),
        }
      }
      catch (error) {
        return { root, configPath, error: (error as Error)?.message ?? String(error), pipelines: [] }
      }
    })

    const orgs = new Map<string, OrganizationMeta>()
    for (const org of listOrganizations()) orgs.set(org.id, org)
    for (const project of projects) {
      for (const pipeline of project.pipelines) {
        const id = String((pipeline as { organizationId?: unknown }).organizationId ?? '').trim()
        if (id && !orgs.has(id))
          orgs.set(id, { id })
      }
    }

    return {
      prefs,
      token: { ref: prefs.tokenRef, configured: tokenConfigured },
      organizations: [...orgs.values()],
      pets,
      projects,
    }
  }

  #findProject(root: string): string {
    const normalized = String(root ?? '').trim()
    if (!normalized)
      throw new Error('缺少 projectRoot')
    if (!listProjects().includes(normalized))
      throw new Error(`未登记的项目：${normalized}`)
    return normalized
  }

  #readRaw(root: string): { file: string, raw: Record<string, unknown> } {
    const file = join(root, '.dsh', 'cicd.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object')
      throw new Error(`配置文件不是对象：${file}`)
    if (!raw.pipelines || typeof raw.pipelines !== 'object')
      raw.pipelines = {}
    return { file, raw }
  }

  #writeValidated(root: string, raw: Record<string, unknown>): void {
    const file = join(root, '.dsh', 'cicd.json')
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    try {
      loadConfig(tmp, { env: loadEnv(root) })
      renameSync(tmp, file)
    }
    catch (error) {
      try {
        writeFileSync(tmp, '')
      }
      catch {}
      throw error
    }
  }

  async #savePipeline(body: Record<string, unknown>): Promise<{ ok: true, pipeline: Record<string, unknown> }> {
    const root = this.#findProject(String(body?.projectRoot ?? ''))
    const name = String(body?.name ?? '').trim()
    if (!/^\w[\w.-]{0,47}$/.test(name))
      throw new Error('流水线名称不合法')
    const { raw } = this.#readRaw(root)
    const pipelines = raw.pipelines as Record<string, Record<string, unknown>>
    const existing = pipelines[name] ?? {}
    const patch = cleanPipeline(body?.pipeline ?? {})
    const pipeline: Record<string, unknown> = {
      ...existing,
      ...patch,
      ...(existing.tokenEnv ? { tokenEnv: existing.tokenEnv } : { tokenEnv: 'YUNXIAO_TOKEN' }),
    }
    if (!pipeline.type)
      pipeline.type = 'yunxiao'
    pipelines[name] = pipeline
    this.#writeValidated(root, raw)
    rememberProject(root)
    const orgId = String(pipeline.organizationId ?? '').trim()
    if (orgId) {
      const known = listOrganizations().find(org => org.id === orgId)
      saveOrganization({
        id: orgId,
        ...(known?.name ? { name: known.name } : {}),
        ...(known?.baseUrl ? { baseUrl: known.baseUrl } : {}),
      })
    }
    return { ok: true, pipeline: pipelineSummary(name, { ...pipeline }, root) }
  }

  #deletePipeline(root: string, name: string): { ok: true } {
    const projectRoot = this.#findProject(root)
    if (!name)
      throw new Error('缺少流水线名称')
    const { raw } = this.#readRaw(projectRoot)
    const pipelines = raw.pipelines as Record<string, unknown>
    delete pipelines[name]
    this.#writeValidated(projectRoot, raw)
    return { ok: true }
  }

  #saveOrg(body: Record<string, unknown>): { ok: true, organization: OrganizationMeta } {
    const id = String(body?.id ?? '').trim()
    if (!/^[\w-]{2,64}$/.test(id))
      throw new Error('organizationId 格式不合法')
    const known = listOrganizations().find(org => org.id === id)
    const name = body?.name !== undefined ? String(body.name) : known?.name
    const baseUrl = body?.baseUrl !== undefined ? String(body.baseUrl) : known?.baseUrl
    const organization: OrganizationMeta = {
      id,
      ...(name ? { name } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }
    saveOrganization(organization)
    return { ok: true, organization }
  }

  #deleteOrg(id: string): { ok: true } {
    const target = String(id ?? '').trim()
    if (!target)
      throw new Error('缺少 organizationId')
    for (const root of listProjects()) {
      try {
        const config = loadConfig(join(root, '.dsh', 'cicd.json'), { env: loadEnv(root) })
        const used = Object.values(config.pipelines).some(pipeline => 'organizationId' in pipeline && pipeline.organizationId === target)
        if (used)
          throw new Error(`组织 ${target} 仍被项目 ${root} 的流水线引用，先改/删这些流水线`)
      }
      catch (error) {
        if (String((error as Error)?.message ?? '').includes('仍被项目'))
          throw error
      }
    }
    deleteOrganization(target)
    return { ok: true }
  }
}
