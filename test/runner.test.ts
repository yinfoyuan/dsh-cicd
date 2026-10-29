import type { Project, RunRecord } from '../src/types.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'vitest'
import { Runner } from '../src/runner.js'
import { saveRecord } from '../src/state.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

it('取消后 refresh 不会被旧快照覆盖成 running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cicd-runner-'))
  dirs.push(root)
  const project: Project = {
    root,
    configPath: join(root, '.dsh', 'cicd.json'),
    runsDir: join(root, '.dsh', 'cicd-runs'),
    env: {},
    config: {
      version: 1,
      path: join(root, '.dsh', 'cicd.json'),
      defaults: { maxConcurrent: 1, timeoutSec: 60, logTailLines: 100 },
      pipelines: {
        p: {
          name: 'p',
          type: 'shell',
          title: 'p',
          description: '',
          confirm: false,
          timeoutSec: 60,
          cwd: '.',
          env: {},
          command: 'node -e ""',
        },
      },
    },
  }
  const record: RunRecord = {
    runId: 'cancel-race',
    pipeline: 'p',
    title: 'p',
    type: 'shell',
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  saveRecord(project.runsDir, record)

  const runner = new Runner()
  const canceled = await runner.cancel(project, { runId: record.runId })
  assert.equal(canceled.status, 'canceled')

  // 模拟并发轮询用取消前的快照覆盖文件（没有 canceledByUser）。
  saveRecord(project.runsDir, { ...record, status: 'running' })

  const refreshed = await runner.refresh(project, { ...record, status: 'running' })
  assert.equal(refreshed?.status, 'canceled')
  assert.equal(refreshed?.canceledByUser, true)
})
