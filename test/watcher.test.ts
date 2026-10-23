import type { Project, RunRecord } from '../src/types.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
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

it('runWatcher：dispose 后不再安排定时器', () => {
  // 只验证 dispose 语义：runner / project / record 用满足类型的最小桩
  const watcher = new RunWatcher({ status: async () => ({}) as RunRecord, logs: async () => '' }, { notice: () => {} })
  watcher.dispose()
  assert.doesNotThrow(() => watcher.watch({} as Project, { runId: 'x' } as RunRecord))
})
