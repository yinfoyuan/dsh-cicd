import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RunRecord, WaitMeta } from '../src/types.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterAll, beforeAll, it } from 'vitest'
import { createPetNotifier, PET_BROADCAST_PATH, petMessage as petMessageTyped } from '../src/pet.js'

function petMessage(record: Partial<RunRecord>, meta: Partial<WaitMeta>): string {
  return petMessageTyped(record as RunRecord, meta as WaitMeta)
}

let server: Server
let port: number
let received: string[] = []
let legacyMode = false
let emptyState = false

function fakeCtx(extra = {}) {
  return {
    tools: { register() {} },
    get: (name: string) => (name === 'webServer' ? { port } : undefined),
    ...extra,
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/dsh-pet-7340/state') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ pets: emptyState ? {} : { main: {} } }))
        return
      }
      if (req.method === 'GET' && req.url === '/dsh-pet-7340/config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ main: { id: 'main', display: 'desktop' } }))
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/dsh-pet-7340/lock?pet=main&surface=any')) {
        if (legacyMode) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, lockId: 'lk-1', petId: 'main', expiresAt: Date.now() + 5000 }))
        return
      }
      if (legacyMode && req.method === 'POST' && req.url?.startsWith('/dsh-pet-7340/broadcast?pet=')) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>')
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/dsh-pet-7340/broadcast?pet=main&surface=any')) {
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST' && req.url === PET_BROADCAST_PATH) {
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/dsh-pet-7340/broadcast?pet=main&surface=any&lock=lk-1')) {
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/dsh-pet-7340/lock/release?pet=main')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

const baseRecord: Partial<RunRecord> = {
  runId: 'r1',
  pipeline: 'deploy',
  title: '示例-部署',
  type: 'yunxiao',
  status: 'running',
  startedAt: new Date().toISOString(),
}

const baseMeta: Partial<WaitMeta> = {
  polls: 3,
  elapsedMs: 192_000,
  timedOut: true,
  abortReason: '',
  errorStreak: 0,
  budgetSec: 180,
  budgetSource: 'default',
  lastDurationMs: 0,
  lastError: '',
}

it('petMessage：超时/失败/成功/取消', () => {
  assert.match(
    petMessage({ ...baseRecord, progress: '阶段 2/2 · 部署（运行中）' }, baseMeta),
    /示例-部署 还在执行.*3m12s.*阶段 2\/2/,
  )
  assert.match(
    petMessage({ ...baseRecord, status: 'failed', durationMs: 52_000 }, { ...baseMeta, timedOut: false }),
    /示例-部署 执行失败（52s）/,
  )
  assert.match(
    petMessage({ ...baseRecord, status: 'succeeded', durationMs: 216_000 }, { ...baseMeta, timedOut: false }),
    /执行成功（3m36s）/,
  )
  assert.match(
    petMessage({ ...baseRecord, status: 'canceled' }, { ...baseMeta, timedOut: false }),
    /已取消/,
  )
})

it('createPetNotifier：直接 broadcast（不取锁）', async () => {
  received = []
  const notifier = createPetNotifier(fakeCtx())
  assert.equal(await notifier.say('  你好  '), true)
  assert.equal(received.length, 1)
  assert.deepEqual(JSON.parse(received[0]), { text: '你好', anim: false, duration: 15000 })
})

it('createPetNotifier：0.3.7 没有 /lock 时回退无锁 broadcast', async () => {
  legacyMode = true
  received = []
  const notifier = createPetNotifier(fakeCtx())
  assert.equal(await notifier.say('旧版'), true)
  assert.equal(received.length, 1)
  assert.deepEqual(JSON.parse(received[0]), { text: '旧版' })
  legacyMode = false
})

it('createPetNotifier：/state 的 pets 为空时从 /config 兜底', async () => {
  emptyState = true
  received = []
  const notifier = createPetNotifier(fakeCtx())
  assert.equal(await notifier.say('兜底'), true)
  assert.equal(received.length, 1)
  assert.equal(JSON.parse(received[0]).text, '兜底')
  emptyState = false
})

it('createPetNotifier：没有 webServer 时静默失败', async () => {
  const notifier = createPetNotifier({ tools: { register() {} } })
  assert.equal(await notifier.say('你好'), false)
})

it('notifyWait：超时会把进度写进气泡', async () => {
  received = []
  const notifier = createPetNotifier(fakeCtx())
  await notifier.notifyWait({ ...baseRecord, progress: '阶段 2/2 · 部署（运行中）' } as RunRecord, baseMeta as WaitMeta)
  assert.equal(received.length, 1)
  assert.match(JSON.parse(received[0]).text, /还在执行/)
})

it('空文本不发送', async () => {
  received = []
  const notifier = createPetNotifier(fakeCtx())
  assert.equal(await notifier.say('   '), false)
  assert.equal(received.length, 0)
})

it('webServer 端口不可达时静默返回 false', async () => {
  const notifier = createPetNotifier({
    tools: { register() {} },
    get: () => ({ port: 1 }),
  })
  assert.equal(await notifier.say('你好'), false)
})
