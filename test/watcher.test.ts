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

it('runWatcher：等待人工确认提示一次，完成后提示继续', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const waiting = {
      runId: 'wait-1',
      pipeline: 'ping',
      title: 'ping',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: '阶段 2/3 · 审批（等待人工确认）',
      waiting: '阶段「审批」',
    } as RunRecord
    const resumed = { ...waiting, waiting: undefined, progress: '阶段 2/3 · 审批（运行中）' }
    let current = waiting
    const notices: string[] = []
    const waits: RunRecord[] = []
    const watcher = new RunWatcher(
      { status: async () => current, logs: async () => '' },
      { notice: text => notices.push(text) },
    )
    watcher.watch(project, waiting, { onWaiting: record => waits.push(record) })
    // 第一轮只是候选：阶段调度瞬间的抖动不能当卡点（实机 run 972）。
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(waits.length, 0)
    assert.equal(notices.filter(text => /等待人工确认/.test(text)).length, 0)

    // 连续第二轮还是同一处等待 → 认定，提示并唤醒一次。
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(waits.length, 1)
    assert.match(notices[0], /等待人工确认/)

    // 持续等待不应重复提示。
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(waits.length, 1)
    assert.equal(notices.filter(text => /等待人工确认/.test(text)).length, 1)

    // 人工处理完成后提示继续。
    current = resumed
    await vi.advanceTimersByTimeAsync(15_000)
    assert.ok(notices.some(text => /继续运行/.test(text)))
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：只抖一轮的等待态不提示不唤醒（阶段调度瞬间）', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const blip = {
      runId: 'blip-1',
      pipeline: 'example-saas',
      title: '示例-管理端（多分支）',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: '阶段 2/3 · 命令（等待人工确认）',
      waiting: '阶段「命令」',
    } as RunRecord
    const running = { ...blip, waiting: undefined, progress: '阶段 2/3 · 命令（运行中）' }
    let calls = 0
    const notices: string[] = []
    const waits: RunRecord[] = []
    const watcher = new RunWatcher(
      // 实机 run 972 的形态：只在一个轮询周期里看到等待，下一轮就正常了。
      { status: async () => (++calls === 1 ? blip : running), logs: async () => '' },
      { notice: text => notices.push(text) },
    )
    watcher.watch(project, blip, { onWaiting: record => waits.push(record) })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(waits.length, 0)
    assert.equal(notices.filter(text => /等待人工确认|人工确认已完成/.test(text)).length, 0)
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：排队等执行机时，久等补一条「在等执行机」的提示（只一次）', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const queued = {
      runId: 'queue-1',
      pipeline: 'example-saas',
      title: '示例-管理端（多分支）',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: '阶段 2/3 · 命令（等待调度）',
      queued: '阶段「命令」',
    } as RunRecord
    const notices: string[] = []
    const watcher = new RunWatcher(
      { status: async () => queued, logs: async () => '' },
      { notice: text => notices.push(text) },
    )
    // 触发时记录里还没有 progress；第一次轮询看到「等待调度」→ 推一条阶段进度。
    watcher.watch(project, { ...queued, progress: '阶段 1/3 · 分支集成（运行中）' } as RunRecord)
    await vi.advanceTimersByTimeAsync(5_000)
    assert.ok(notices.some(text => /等待调度/.test(text)))
    assert.equal(notices.filter(text => /等执行机/.test(text)).length, 0)

    // 排队超过 90s：补一条解释，且只补一次。
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(notices.filter(text => /等执行机/.test(text)).length, 1)
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(notices.filter(text => /等执行机/.test(text)).length, 1)

    // 排队结束不重复提示；全程不能出现「等待人工确认」。
    assert.equal(notices.filter(text => /等待人工确认/.test(text)).length, 0)
    watcher.dispose()
  }
  finally {
    vi.useRealTimers()
  }
})

it('runWatcher：人工卡点被拒绝时，失败提示点明原因（不误报成构建挂了）', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const running = {
      runId: 'refuse-1',
      pipeline: 'example-saas',
      title: '示例-管理端（多分支）',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
    } as RunRecord
    const failed = {
      ...running,
      status: 'failed' as const,
      durationMs: 79_000,
      gateRefused: '已拒绝人工卡点：阶段「新阶段」任务「人工卡点」',
    }
    const notices: string[] = []
    let hint = ''
    const watcher = new RunWatcher(
      // 被拒绝的运行不该再去翻日志找原因（错误信息会抛，验证走的是拒绝提示分支）。
      { status: async () => failed, logs: async () => { throw new Error('不应该读日志') } },
      { notice: text => notices.push(text) },
    )
    watcher.watch(project, running, {
      onTerminal: (_record, value) => {
        hint = value ?? ''
      },
    })
    await vi.advanceTimersByTimeAsync(5_000)
    assert.match(hint, /已拒绝人工卡点：阶段「新阶段」/)
    assert.match(notices.join('\n'), /已拒绝人工卡点：阶段「新阶段」/)
    assert.match(notices.join('\n'), /运行因此终止/)
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

it('runWatcher：取消后抑制在途的等待提醒', async () => {
  vi.useFakeTimers()
  try {
    const project = { root: 'D:/repo' } as Project
    const waiting = {
      runId: 'mute-1',
      pipeline: 'ping',
      title: 'ping',
      type: 'yunxiao',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: '阶段 2/3 · 审批（等待人工确认）',
      waiting: '阶段「审批」',
    } as RunRecord
    const notices: string[] = []
    const waits: RunRecord[] = []
    const watcher = new RunWatcher(
      { status: async () => waiting, logs: async () => '' },
      { notice: text => notices.push(text) },
    )
    watcher.watch(project, waiting, { onWaiting: record => waits.push(record) })
    watcher.muteWaiting('mute-1')
    await vi.advanceTimersByTimeAsync(20_000)
    assert.equal(waits.length, 0)
    assert.equal(notices.filter(text => /等待人工确认/.test(text)).length, 0)
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
