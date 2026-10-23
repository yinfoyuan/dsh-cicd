import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { resolveProject } from '../src/project.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cicd-project-'))
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'cicd.json'),
    JSON.stringify({ version: 1, pipelines: { ping: { type: 'shell', command: 'node -e "console.log(1)"' } } }),
    'utf8',
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function execFor(cwd: string) {
  return { agent: { session: { header: { cwd } } } }
}

it('project：配置与运行目录都用 path.resolve 统一成原生路径', () => {
  const project = resolveProject(execFor(root), {})
  assert.equal(project.root, resolve(root))
  assert.equal(project.configPath, join(resolve(root), '.dsh', 'cicd.json'))
  assert.equal(project.runsDir, join(resolve(root), '.dsh', 'cicd-runs'))
  // 不允许出现混合分隔符或重复分隔符
  assert.equal(project.runsDir.includes(`${sep}${sep}`), false)
  if (sep === '\\')
    assert.equal(project.runsDir.includes('/'), false)
})

it('project：cwd 用正斜杠传入时也会被 normalize', () => {
  const mixed = root.replaceAll('\\', '/')
  const project = resolveProject(execFor(mixed), {})
  assert.equal(project.root, resolve(root))
  assert.equal(project.runsDir, join(resolve(root), '.dsh', 'cicd-runs'))
})

it('project：自定义 configFile / runsDir 同样走 resolve', () => {
  const project = resolveProject(execFor(root), {
    configFile: '.dsh/cicd.json',
    runsDir: 'custom/runs',
  })
  assert.equal(project.runsDir, join(resolve(root), 'custom', 'runs'))
})
