import type { Project, RunRecord } from '../src/types.js'
import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { failureHint, mergeConflictPending, RunWatcher } from '../src/watcher.js'

it('failureHint：识别合并冲突', () => {
  assert.match(failureHint('fatal: merge conflict in src/a.ts'), /合并冲突/)
  assert.match(failureHint('CONFLICT (content): Merge conflict in src/a.ts'), /合并冲突/)
  assert.match(failureHint('合并冲突，请手动解决'), /合并冲突/)
})

it('failureHint：识别用户取消', () => {
  assert.match(failureHint('用户已取消'), /取消/)
  assert.match(failureHint('UserCanceled'), /取消/)
})

it('failureHint：普通失败不误报', () => {
  assert.equal(failureHint('build failed: TS2304'), '')
})

it('mergeConflictPending：识别「暂停等人工合并」', () => {
  assert.equal(mergeConflictPending('Merge conflicted, job paused.'), true)
  assert.equal(mergeConflictPending('自动合并失败，修正冲突然后提交修正的结果。'), true)
  assert.equal(mergeConflictPending('click 【Conflict Resolved】button on Aone'), true)
  assert.equal(mergeConflictPending('[INFO] 克隆成功'), false)
})

it('runWatcher：终态时调用 onTerminal（followUp 唤醒入口）', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const running = {
      runId: 'follow-1',
      pipeline: 'ping',
      title: 'ping',
      type: 'shell',
      status: 'running',
      startedAt: new Date().toISOString(),
    } as RunRecord
    const failed = { ...running, status: 'failed' as const, durationMs: 1_200 }
    const followed: Array<{ record: RunRecord, hint?: string }> = []
    const watcher = new RunWatcher(
      {
        status: async () => failed,
        logs: async () => 'fatal: merge conflict in src/a.ts',
      },
      { notice: () => {} },
    )
    watcher.watch(project, running, { onTerminal: (record, hint) => followed.push({ record, hint }) })
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(followed.length, 1)
    assert.equal(followed[0].record.status, 'failed')
    assert.match(String(followed[0].hint), /合并冲突/)
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：检测到合并冲突时调用 onConflict（followUp 唤醒入口）', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const running = {
      runId: 'conflict-1',
      pipeline: 'ping',
      title: 'ping',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: '阶段 1/3 · 分支集成（运行中）',
      note: 'Merge conflicted, job paused',
    } as RunRecord
    const conflicts: RunRecord[] = []
    const terminals: RunRecord[] = []
    const watcher = new RunWatcher(
      { status: async () => running, logs: async () => '' },
      { notice: () => {} },
    )
    watcher.watch(project, running, {
      onConflict: record => conflicts.push(record),
      onTerminal: record => terminals.push(record),
    })
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(conflicts.length, 1)
    assert.equal(terminals.length, 0)
    // 冲突暂停不是终态；后续轮询不应重复唤醒。
    await vi.advanceTimersByTimeAsync(20_000)
    assert.equal(conflicts.length, 1)
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：用户主动取消保留 toast，但不唤醒模型', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const running = {
      runId: 'user-cancel-1',
      pipeline: 'ping',
      title: 'ping',
      type: 'shell',
      status: 'running',
      startedAt: new Date().toISOString(),
    } as RunRecord
    const canceled = { ...running, status: 'canceled' as const, canceledByUser: true }
    const notices: string[] = []
    const terminals: RunRecord[] = []
    const watcher = new RunWatcher(
      { status: async () => canceled, logs: async () => '' },
      { notice: text => notices.push(text) },
    )
    watcher.watch(project, running, { onTerminal: record => terminals.push(record) })
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(notices.length, 1)
    assert.match(notices[0], /已取消/)
    assert.equal(terminals.length, 0)
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：dispose 后不再安排定时器', () => {
  // 只验证 dispose 语义：runner / project / record 用满足类型的最小桩
  const watcher = new RunWatcher({ status: async () => ({}) as RunRecord, logs: async () => '' }, { notice: () => {} })
  watcher.dispose()
  assert.doesNotThrow(() => watcher.watch({} as Project, { runId: 'x' } as RunRecord))
})
