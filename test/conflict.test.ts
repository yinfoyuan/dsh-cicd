import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseConflictInfo } from '../src/conflict.js'

const SAMPLE = `
[09:12:22] [INFO] 流水线代码源开启了分支管理器
[09:12:23] [INFO] 合并 feat(fill-v3)时出现冲突
[09:12:23] [INFO] 冲突（内容）：合并冲突于 pnpm-lock.yaml
[09:12:23] [INFO] 冲突（内容）：合并冲突于 package.json
[09:12:23] Merge conflicted, job paused.
[09:12:23] If you have resolved the conflicts, click 【Conflict Resolved】button on Aone
[09:12:22] RELEASE_BRANCH_NAME=release/20261022-092943960793749_release_123456_894
[09:12:22] FEATURE_BRANCHS=feat(fill-v3) 
[09:12:22] BASE_BRANCH_NAME=main
[09:12:22] REPO_URL=http://git.example.com/one-piece/example-saas.git
`

it('parseConflictInfo：提取冲突文件、分支、仓库与暂停标记', () => {
  const info = parseConflictInfo(SAMPLE)
  assert.equal(info.hasConflict, true)
  assert.equal(info.paused, true)
  assert.deepEqual(info.conflictFiles, ['pnpm-lock.yaml', 'package.json'])
  assert.deepEqual(info.featureBranches, ['feat(fill-v3)'])
  assert.equal(info.baseBranch, 'main')
  assert.match(String(info.releaseBranch), /^release\//)
  assert.equal(info.repoUrl, 'http://git.example.com/one-piece/example-saas.git')
  assert.equal(info.conflictBranch, 'feat(fill-v3)')
  assert.match(info.logTail, /Conflict Resolved/)
})

it('parseConflictInfo：没有冲突标记时 hasConflict=false', () => {
  const info = parseConflictInfo('[INFO] 克隆成功\n[INFO] build ok')
  assert.equal(info.hasConflict, false)
  assert.deepEqual(info.conflictFiles, [])
  assert.deepEqual(info.featureBranches, [])
})
