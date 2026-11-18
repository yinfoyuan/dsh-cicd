import type { RunRecord } from '../src/types.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { noticeLabel, recordText } from '../src/format.js'

const base = {
  runId: 'r1',
  pipeline: 'example-saas',
  title: '示例-管理端（多分支）',
  type: 'yunxiao',
  status: 'failed',
  startedAt: new Date().toISOString(),
} as RunRecord

it('noticeLabel：环境前缀 + 标题（没标题回退流水线名）', () => {
  assert.equal(noticeLabel({ ...base, environment: 'test' } as RunRecord), '[test] 示例-管理端（多分支）')
  assert.equal(noticeLabel({ ...base, title: '' } as RunRecord), 'example-saas')
})

it('recordText：人工卡点被拒绝要写明是这次失败的原因', () => {
  const text = recordText({ ...base, gateRefused: '已拒绝人工卡点：阶段「新阶段」任务「人工卡点」' } as RunRecord)
  assert.match(text, /gateRefused: 已拒绝人工卡点：阶段「新阶段」任务「人工卡点」/)
  assert.match(text, /这是这次失败的直接原因/)
  // 没被拒绝的运行照旧不出现这一行。
  assert.doesNotMatch(recordText(base), /gateRefused/)
})
