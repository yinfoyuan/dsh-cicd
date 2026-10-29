import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { BranchBroker, ROUTE_PREFIX } from '../src/branch-broker.js'

interface Notice {
  text: string
  runId?: string
  project?: string
  at?: number
  count?: number
}

interface NoticesResponse {
  seq: number
  notices: Notice[]
}

interface BranchRequest {
  id: string
  kind?: string
  title: string
  previous: string[]
  showBranches?: boolean
  showComment?: boolean
  comment?: string
  envs?: Record<string, string>
  variables?: Array<{ key: string }>
  environment?: string
  tier?: string
}

interface RequestResponse {
  request: BranchRequest | null
}

interface AnswerResponse {
  ok: boolean
}

let server: Server
let baseUrl: string
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
let storeDir: string
let storePath: string

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'dsh-cicd-broker-'))
  storePath = join(storeDir, 'notices.json')
  server = createServer((req, res) => handler?.(req, res))
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(storeDir, { recursive: true, force: true })
})

function fakeCtx() {
  return {
    tools: { register() {} },
    get: (name: string) => (name === 'webServer'
      ? { register: (spec: { handler: (req: IncomingMessage, res: ServerResponse) => void }) => { handler = spec.handler } }
      : undefined),
  }
}

/** 测试统一用临时 store，避免写真实的 ~/.dsh/cicd-notices.json。 */
function makeBroker() {
  return new BranchBroker(fakeCtx(), { storePath })
}

async function getRequest(): Promise<RequestResponse> {
  const res = await fetch(`${baseUrl}${ROUTE_PREFIX}/branch/request`)
  return res.json() as Promise<RequestResponse>
}

async function postAnswer(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${ROUTE_PREFIX}/branch/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as AnswerResponse }
}

it('broker：路由注册 + client 在线判定', async () => {
  const broker = makeBroker()
  assert.equal(broker.registerRoutes(), true)
  assert.equal(broker.hasClient(), false)

  await getRequest()
  assert.equal(broker.hasClient(), true)
  broker.dispose()
})

it('broker：请求 → 弹窗索取 → 提交答案 → 返回选择', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  await getRequest() // 标记 client 在线

  const pending = broker.ask({ title: '多分支', previous: ['a', 'b'], environment: 'test', tier: 'testing' })
  const { request } = await getRequest()
  assert.equal(request!.title, '多分支')
  assert.deepEqual(request!.previous, ['a', 'b'])
  assert.equal(request!.environment, 'test')
  assert.equal(request!.tier, 'testing')

  const answer = await postAnswer({ id: request!.id, selected: ['a'], custom: 'c' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)

  const choice = await pending
  assert.deepEqual(choice.branches, ['a', 'c'])
  assert.deepEqual(choice.kept, ['a'])
  assert.deepEqual(choice.removed, ['b'])
  assert.deepEqual(choice.added, ['c'])
  broker.dispose()
})

it('broker：取消 → 拒绝', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  await getRequest()
  const pending = broker.ask({ title: 'x', previous: ['a'] })
  const rejected = assert.rejects(() => pending, /取消/)
  const { request } = await getRequest()
  await postAnswer({ id: request!.id, cancelled: true })
  await rejected
  broker.dispose()
})

it('broker：全部取消且无新增 → 至少一个分支', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  await getRequest()
  const pending = broker.ask({ title: 'x', previous: ['a'] })
  const rejected = assert.rejects(() => pending, /至少要有一个运行分支/)
  const { request } = await getRequest()
  await postAnswer({ id: request!.id, selected: [], custom: '' })
  await rejected
  broker.dispose()
})

it('broker：运行配置请求 → 变量白名单 + 空值不覆盖', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  await getRequest()

  const pending = broker.askRunConfig({
    title: 'deploy',
    previous: ['main'],
    showBranches: true,
    showComment: true,
    comment: '预发布版本',
    envs: { A: '1' },
    variables: [{ key: 'A' }, { key: 'B', encrypted: true }],
  })
  const { request } = await getRequest()
  assert.equal(request!.kind, 'runConfig')
  assert.equal(request!.showBranches, true)
  assert.equal(request!.showComment, true)
  assert.equal(request!.comment, '预发布版本')
  assert.deepEqual(request!.envs, { A: '1' })
  assert.equal(request!.variables?.length, 2)

  const answer = await postAnswer({
    id: request!.id,
    selected: ['main'],
    envs: { A: '1', B: '', UNKNOWN: 'x' },
    comment: '发版',
  })
  assert.equal(answer.status, 200)

  const choice = await pending
  assert.deepEqual(choice.envs, { A: '1' })
  assert.deepEqual(choice.branches?.branches, ['main'])
  assert.equal(choice.comment, '发版')
  broker.dispose()
})

it('broker：notices 增量推送', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  broker.notify('第一条')
  broker.notify('第二条', 'warn')

  const all = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices?since=0`)).json() as NoticesResponse
  assert.equal(all.seq, 2)
  assert.deepEqual(all.notices.map((notice: Notice) => notice.text), ['第一条', '第二条'])

  const after = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices?since=1`)).json() as NoticesResponse
  assert.deepEqual(after.notices.map((notice: Notice) => notice.text), ['第二条'])

  const history = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history?limit=10`)).json() as NoticesResponse
  assert.deepEqual(history.notices.map((notice: Notice) => notice.text), ['第二条', '第一条'])
  assert.equal(typeof history.notices[0].at, 'number')

  await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/clear`, { method: 'POST' })
  const cleared = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history`)).json() as NoticesResponse
  assert.deepEqual(cleared.notices, [])
  broker.dispose()
})

it('broker：连续相同通知只保留最新一条', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  broker.clearNotices()
  broker.notify('阶段 1/3 · 分支集成（运行中）', 'info', 'D:/work/a')
  broker.notify('阶段 1/3 · 分支集成（运行中）', 'info', 'D:/work/a')

  const history = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history`)).json() as NoticesResponse
  assert.equal(history.notices.length, 1)
  assert.equal(history.notices[0].count, 2)
  broker.dispose()
})

it('broker：同一次运行内去重，不同运行分开', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  broker.clearNotices()
  broker.notify('阶段 1/3 · 分支集成（运行中）', 'info', 'D:/work/a', 'run-1')
  broker.notify('阶段 1/3 · 分支集成（运行中）', 'info', 'D:/work/a', 'run-1')
  broker.notify('阶段 1/3 · 分支集成（运行中）', 'info', 'D:/work/a', 'run-2')

  const history = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history`)).json() as NoticesResponse
  assert.equal(history.notices.length, 2)
  assert.deepEqual(history.notices.map((notice: Notice) => notice.runId), ['run-2', 'run-1'])
  assert.equal(history.notices[0].count, 1)
  assert.equal(history.notices[1].count, 2)
  broker.dispose()
})

it('broker：通知落盘并在新实例恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cicd-notices-'))
  const store = join(dir, 'notices.json')
  const first = new BranchBroker(fakeCtx(), { storePath: store })
  first.notify('第一条', 'info', 'D:/work/a')
  first.notify('第二条', 'warn', 'D:/work/b')

  const second = new BranchBroker(fakeCtx(), { storePath: store })
  second.registerRoutes()
  const history = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history`)).json() as NoticesResponse
  assert.deepEqual(history.notices.map((notice: Notice) => notice.text), ['第二条', '第一条'])
  assert.deepEqual(history.notices.map((notice: Notice) => notice.project), ['D:/work/b', 'D:/work/a'])

  second.clearNotices()
  const third = new BranchBroker(fakeCtx(), { storePath: store })
  third.registerRoutes()
  const cleared = await (await fetch(`${baseUrl}${ROUTE_PREFIX}/notices/history`)).json() as NoticesResponse
  assert.deepEqual(cleared.notices, [])
  rmSync(dir, { recursive: true, force: true })
})

it('broker：不匹配的请求 id 返回 409', async () => {
  const broker = makeBroker()
  broker.registerRoutes()
  const answer = await postAnswer({ id: 'nope', selected: ['a'] })
  assert.equal(answer.status, 409)
  broker.dispose()
})
