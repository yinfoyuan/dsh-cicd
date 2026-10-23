import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { ConfigService } from '../src/config-service.js'
import { rememberProject } from '../src/settings-store.js'

interface ConfigSnapshot {
  projects: Array<{ root: string, pipelines: Array<{ name: string }> }>
  token: { configured: boolean }
  prefs: { toast: boolean, historyLimit: number }
}

let home: string
let previousHome: string | undefined
let root: string
let server: Server
let baseUrl: string
let tokenValue = ''

beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-cicd-config-api-'))
  process.env.DSH_HOME = home
  root = join(home, 'project')
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'cicd.json'), JSON.stringify({
    pipelines: {
      ping: { type: 'shell', title: 'ping', command: 'echo 1' },
    },
  }, null, 2), 'utf8')
  rememberProject(root)

  const credentials = {
    describe: async (refs: string | string[]) => Object.fromEntries((Array.isArray(refs) ? refs : [refs]).map(ref => [ref, { configured: Boolean(tokenValue) }])),
    set: async (_ref: string, value: string) => { tokenValue = value },
    unset: async () => { tokenValue = '' },
  }
  const ctx = {
    tools: { register() {} },
    get: (name: string) => (name === 'credentials' ? credentials : undefined),
    credentials,
  }
  const service = new ConfigService(ctx)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void service.handle(req, res, url.pathname, url)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server?.close()
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json() as ConfigSnapshot }
}

it('config API：读取项目与流水线', async () => {
  const { status, json } = await call('GET', '/dsh-cicd/config')
  assert.equal(status, 200)
  assert.equal(json.projects.length, 1)
  assert.equal(json.projects[0].root, root)
  assert.equal(json.projects[0].pipelines[0].name, 'ping')
  assert.equal(json.token.configured, false)
})

it('config API：新增流水线并写入文件', async () => {
  const { status } = await call('PUT', '/dsh-cicd/config/pipeline', {
    projectRoot: root,
    name: 'deploy',
    pipeline: { type: 'shell', title: 'deploy', command: 'echo 2' },
  })
  assert.equal(status, 200)
  const raw = JSON.parse(readFileSync(join(root, '.dsh', 'cicd.json'), 'utf8'))
  assert.equal(raw.pipelines.deploy.command, 'echo 2')
})

it('config API：组织与全局偏好', async () => {
  const org = await call('PUT', '/dsh-cicd/config/organization', { id: 'org1', name: '测试组织' })
  assert.equal(org.status, 200)
  const prefs = await call('PUT', '/dsh-cicd/config/prefs', { toast: false, historyLimit: 50 })
  assert.equal(prefs.status, 200)
  assert.equal(prefs.json.prefs.toast, false)
  assert.equal(prefs.json.prefs.historyLimit, 50)
})

it('config API：设置 token 后状态为已配置', async () => {
  const set = await call('POST', '/dsh-cicd/config/token', { value: 'secret-token' })
  assert.equal(set.status, 200)
  assert.equal(tokenValue, 'secret-token')
  const snapshot = await call('GET', '/dsh-cicd/config')
  assert.equal(snapshot.json.token.configured, true)
})
