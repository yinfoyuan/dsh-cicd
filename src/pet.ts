import type { PluginContext, RunRecord, WaitMeta } from './types.js'
/**
 * 可选的 dsh-pet 集成：把流水线进度“喂”给桌宠气泡。
 *
 * dsh-pet 的对外 HTTP API（前缀 `/dsh-pet-7340`）：
 * - `GET /state` 找桌宠 id；
 * - `POST /lock?pet=&surface=any` 取占用锁；
 * - `POST /broadcast?pet=&surface=any&lock=` 投喂文本（新版必须带锁）；
 * - `POST /lock/release?pet=` 立刻释放。
 * 老版本没有 lock 时回退为无锁 `POST /broadcast`。
 *
 * 约束：
 * - 失败必须静默：桌宠没装/路由 404/超时都不能影响流水线工具；
 * - fire-and-forget：工具返回不等气泡；
 * - 可整体关闭：插件配置 `pet: false`。
 */
import { durationText } from './runner.js'
import { readGlobalSettings } from './settings-store.js'

/** 老版本 dsh-pet 的无锁广播路由（兼容回退）。 */
export const PET_BROADCAST_PATH = '/dsh-pet-7340/broadcast'

export interface PetAttempt {
  at: string
  step: string
  detail?: Record<string, unknown>
}

let lastAttempt: PetAttempt | null = null

function trace(step: string, detail?: Record<string, unknown>): void {
  lastAttempt = { at: new Date().toISOString(), step, ...(detail ? { detail } : {}) }
}

/** 最近一次投喂尝试（诊断用；不包含 token）。 */
export function petDebug(): PetAttempt | null {
  return lastAttempt
}

export interface PetNotifier {
  /** 把一段文本写进桌宠气泡。返回是否成功（失败不抛错）。 */
  say: (text: string) => Promise<boolean>
  /** 根据一次等待的结果生成提示并投喂；不需要提示的消息不会发送。 */
  notifyWait: (record: RunRecord, meta: WaitMeta) => Promise<void>
}

export interface PetInfo {
  id: string
  name?: string
}

interface PetResponse {
  ok?: boolean
  reason?: string
  lockId?: string
}

function petPort(ctx: PluginContext): number {
  const webServer = (ctx.get?.('webServer', false) ?? (ctx as { webServer?: { port?: number } }).webServer) as { port?: number } | undefined
  return Number(webServer?.port)
}

function addPet(target: Map<string, PetInfo>, id: unknown, name?: unknown): void {
  const key = String(id ?? '').trim()
  if (!key)
    return
  const label = String(name ?? '').trim()
  const existing = target.get(key)
  if (existing) {
    if (!existing.name && label)
      existing.name = label
    return
  }
  target.set(key, { id: key, ...(label ? { name: label } : {}) })
}

/** 读取 dsh-pet 的宠物列表（id + 名称），用于配置页选择和诊断。 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
export async function listPets(ctx: PluginContext): Promise<PetInfo[]> {
  const port = petPort(ctx)
  if (!Number.isFinite(port) || port <= 0)
    return []
  const base = `http://127.0.0.1:${port}/dsh-pet-7340`
  const pets = new Map<string, PetInfo>()

  try {
    const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(1_500) })
    if (res.ok) {
      const raw = await res.json().catch(() => null) as Record<string, unknown> | null
      if (Array.isArray(raw?.pets)) {
        for (const pet of raw.pets) addPet(pets, (pet as { id?: unknown })?.id, (pet as { name?: unknown })?.name)
      }
      for (const [key, value] of Object.entries(raw ?? {})) {
        if (key === 'pets')
          continue
        const entry = value as { pets?: unknown[], name?: unknown }
        if (Array.isArray(entry.pets)) {
          for (const pet of entry.pets) addPet(pets, (pet as { id?: unknown })?.id ?? key, (pet as { name?: unknown })?.name)
        }
        else if (value && typeof value === 'object') {
          addPet(pets, key, entry.name)
        }
      }
    }
  }
  catch {}

  if (pets.size === 0) {
    try {
      const res = await fetch(`${base}/state`, { signal: AbortSignal.timeout(1_500) })
      if (res.ok) {
        const state = await res.json().catch(() => null) as { pets?: Record<string, unknown> } | null
        for (const id of Object.keys(state?.pets ?? {})) addPet(pets, id)
      }
    }
    catch {}
  }

  return [...pets.values()].sort((a, b) => {
    if (a.id === 'main')
      return -1
    if (b.id === 'main')
      return 1
    return a.id.localeCompare(b.id)
  })
}

/** 根据等待结果生成桌宠提示文案；返回空串表示不提示。 */
export function petMessage(record: RunRecord, meta: WaitMeta): string {
  const title = record.title || record.pipeline
  const env = record.environment ? `[${record.environment}] ` : ''
  const spent = record.durationMs ?? meta.elapsedMs
  const progress = record.progress ? ` · ${record.progress}` : ''

  if (meta.timedOut || record.status === 'running') {
    return `⏳ ${env}${title} 还在执行（已等 ${durationText(meta.elapsedMs)}）${progress}`
  }
  if (record.status === 'failed')
    return `❌ ${env}${title} 执行失败（${durationText(spent)}）`
  if (record.status === 'succeeded')
    return `✅ ${env}${title} 执行成功（${durationText(spent)}）`
  if (record.status === 'canceled')
    return `⛔ ${env}${title} 已取消`
  if (record.status === 'lost')
    return `❓ ${env}${title} 状态丢失，请到平台确认`
  return ''
}

/**
 * @param ctx 插件上下文；通过 `ctx.get('webServer', false)` 拿端口，
 *            dsh-pet 不在时返回 undefined，本集成自动静默。
 */
export function createPetNotifier(ctx: PluginContext, preferredPetId?: string): PetNotifier {
  let disabled = false
  let legacy = false
  let petId: string | undefined

  function base(port: number): string {
    return `http://127.0.0.1:${port}/dsh-pet-7340`
  }

  async function call(
    port: number,
    path: string,
    init: { method: string, body?: string },
  ): Promise<{ status: number, ok: boolean, json: PetResponse | null }> {
    const res = await fetch(`${base(port)}${path}`, {
      method: init.method,
      ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: init.body }),
      signal: AbortSignal.timeout(1_500),
    })
    const json = await res.json().catch(() => null) as PetResponse | null
    return { status: res.status, ok: res.ok, json }
  }

  async function findPet(): Promise<string | null> {
    const preferred = String(preferredPetId ?? readGlobalSettings().petId ?? '').trim()
    if (petId && (!preferred || petId === preferred))
      return petId
    petId = undefined

    const pets = await listPets(ctx)
    if (pets.length === 0)
      return null
    const chosen = preferred && pets.some(pet => pet.id === preferred)
      ? preferred
      : pets.some(pet => pet.id === 'main') ? 'main' : pets[0]?.id
    if (!chosen)
      return null
    petId = chosen
    return chosen
  }

  /** 老版本 dsh-pet 没有 lock：退回旧的 broadcast 形态。 */
  async function legacyBroadcast(port: number, text: string): Promise<boolean> {
    legacy = true
    const res = await call(port, '/broadcast', { method: 'POST', body: JSON.stringify({ text }) })
    if (res.status === 404) {
      disabled = true
      return false
    }
    return res.ok && res.json?.ok === true
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
  async function say(text: string): Promise<boolean> {
    if (disabled)
      return false
    const trimmed = String(text ?? '').trim()
    if (!trimmed)
      return false
    trace('start', { text: trimmed.slice(0, 120) })

    const webServer = (ctx.get?.('webServer', false) ?? (ctx as { webServer?: { port?: number } }).webServer) as { port?: number } | undefined
    const port = Number(webServer?.port)
    if (!Number.isFinite(port) || port <= 0) {
      disabled = true
      return false
    }

    if (legacy)
      return legacyBroadcast(port, trimmed).catch(() => false)

    try {
      const pet = await findPet()
      if (!pet) {
        trace('no-pet')
        return false
      }
      trace('pet', { pet })
      const query = `pet=${encodeURIComponent(pet)}&surface=any`
      const payload = JSON.stringify({ text: trimmed, anim: false, duration: 15_000 })

      // 优先无锁直接投喂：避免取锁/释放导致桌宠自己的状态气泡立刻覆盖通知。
      const direct = await call(port, `/broadcast?${query}`, { method: 'POST', body: payload })
      trace('direct', { status: direct.status, ok: direct.ok, reason: direct.json?.reason ?? null })
      if (direct.status === 404) {
        disabled = true
        return false
      }
      if (direct.status === 400 && !direct.json)
        return legacyBroadcast(port, trimmed)
      if (direct.ok && direct.json?.ok === true)
        return true

      // 缓存的 petId 失效时，下一次重新从 /state 或 /config 发现。
      if (direct.json?.reason === 'unknown-pet' || direct.json?.reason === 'pet-not-displayed') {
        petId = undefined
        return false
      }

      // 只有别的插件正在占用时才取锁，投喂后立刻释放。
      if (direct.json?.reason !== 'lock-required')
        return false
      const lock = await call(port, `/lock?${query}`, { method: 'POST', body: '{}' })
      if (lock.status === 404 || (!lock.json && lock.status >= 400))
        return legacyBroadcast(port, trimmed)
      if (!lock.ok || lock.json?.ok !== true)
        return false
      const lockId = String(lock.json?.lockId ?? '')
      if (!lockId)
        return false

      try {
        const res = await call(port, `/broadcast?${query}&lock=${encodeURIComponent(lockId)}`, {
          method: 'POST',
          body: payload,
        })
        if (res.status === 404) {
          disabled = true
          return false
        }
        return res.ok && res.json?.ok === true
      }
      finally {
        await call(port, `/lock/release?pet=${encodeURIComponent(pet)}`, {
          method: 'POST',
          body: JSON.stringify({ lockId }),
        }).catch(() => null)
      }
    }
    catch (error) {
      // 超时/网络抖动不永久禁用，下一次通知继续尝试；只有 404 才说明桌宠没装。
      trace('error', { message: (error as Error)?.message ?? String(error) })
      return false
    }
  }

  return {
    say,
    async notifyWait(record: RunRecord, meta: WaitMeta): Promise<void> {
      const text = petMessage(record, meta)
      if (text)
        await say(text)
    },
  }
}
