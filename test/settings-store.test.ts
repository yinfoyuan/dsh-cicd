import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_TOKEN_REF,
  deleteOrganization,
  listOrganizations,
  listProjects,
  readGlobalSettings,
  rememberProject,
  saveOrganization,
  writeGlobalSettings,
} from '../src/settings-store.js'

let home: string
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-cicd-settings-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  if (previousHome === undefined)
    delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

it('settings：默认值', () => {
  const prefs = readGlobalSettings()
  assert.equal(prefs.tokenRef, DEFAULT_TOKEN_REF)
  assert.equal(prefs.pet, true)
  assert.equal(prefs.petId, '')
  assert.equal(prefs.toast, true)
  assert.equal(prefs.historyLimit, DEFAULT_HISTORY_LIMIT)
})

it('settings：写入偏好并夹取 historyLimit', () => {
  const prefs = writeGlobalSettings({ pet: false, petId: 'main', toast: false, historyLimit: 9999 })
  assert.equal(prefs.pet, false)
  assert.equal(prefs.petId, 'main')
  assert.equal(prefs.toast, false)
  assert.equal(prefs.historyLimit, 500)
})

it('settings：组织元数据增删', () => {
  saveOrganization({ id: 'org1', name: '测试组织', baseUrl: 'https://example.com' })
  assert.deepEqual(listOrganizations(), [{ id: 'org1', name: '测试组织', baseUrl: 'https://example.com' }])
  deleteOrganization('org1')
  assert.deepEqual(listOrganizations(), [])
})

it('settings：项目注册表只返回仍存在的目录', () => {
  const root = join(home, 'project')
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'cicd.json'), '{"pipelines":{"ping":{"type":"shell","command":"echo 1"}}}', 'utf8')
  rememberProject(root)
  assert.deepEqual(listProjects(), [root])
  rmSync(root, { recursive: true, force: true })
  assert.deepEqual(listProjects(), [])
})
