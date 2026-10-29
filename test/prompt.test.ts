import assert from 'node:assert/strict'
import { it } from 'vitest'
import { askBranches, describeChoice, parseBranchAnswer, parseKeepAnswer, parseRunConfigAnswer } from '../src/prompt.js'

it('parseBranchAnswer：移除勾选 + 输入框新增（逗号/空格/全角逗号）', () => {
  const choice = parseBranchAnswer(['a', 'b', 'c'], {
    branches: { selected: ['b'], custom: 'd, e，f' },
  })
  assert.deepEqual(choice.branches, ['a', 'c', 'd', 'e', 'f'])
  assert.deepEqual(choice.kept, ['a', 'c'])
  assert.deepEqual(choice.removed, ['b'])
  assert.deepEqual(choice.added, ['d', 'e', 'f'])
})

it('parseBranchAnswer：什么都不勾、输入框为空 = 全部保留', () => {
  const choice = parseBranchAnswer(['a', 'b'], { branches: {} })
  assert.deepEqual(choice.branches, ['a', 'b'])
  assert.deepEqual(choice.kept, ['a', 'b'])
  assert.deepEqual(choice.removed, [])
  assert.deepEqual(choice.added, [])
})

it('parseBranchAnswer：只填输入框 = 全保留 + 新增', () => {
  const choice = parseBranchAnswer(['a'], { branches: { custom: 'b' } })
  assert.deepEqual(choice.branches, ['a', 'b'])
  assert.deepEqual(choice.added, ['b'])
})

it('parseBranchAnswer：新增里重复上次分支不会重复添加', () => {
  const choice = parseBranchAnswer(['a'], { branches: { custom: 'a, b' } })
  assert.deepEqual(choice.branches, ['a', 'b'])
  assert.deepEqual(choice.added, ['b'])
})

it('parseBranchAnswer：全部移除且无新增 = 空', () => {
  const choice = parseBranchAnswer(['a'], { branches: { selected: ['a', 'zzz'] } })
  assert.deepEqual(choice.branches, [])
  assert.deepEqual(choice.removed, ['a'])
})

it('describeChoice：保留/新增/移除', () => {
  const choice = parseBranchAnswer(['a', 'b'], {
    branches: { selected: ['b'], custom: 'c' },
  })
  assert.equal(describeChoice(choice), '保留 1 条，新增 1 条，移除 1 条')
})

interface BranchQuestion {
  header: string
  question: string
  options: Array<{ description?: string }>
}

interface AskRequest {
  title: string
  questions: BranchQuestion[]
}

it('askBranches：文案明确「勾选 = 取消」，默认不勾 = 保留', async () => {
  let request: AskRequest | undefined
  const ctx = {
    tools: { register() {} },
    get: () => ({
      ask: async (req: AskRequest) => {
        request = req
        return { answers: [{ id: 'branches', selected: [], custom: '' }] }
      },
    }),
  }
  const choice = await askBranches(ctx, { title: '多分支', previous: ['a', 'b'] })
  const question = request!.questions[0]
  assert.match(question.header, /勾选 = 取消/)
  assert.match(question.question, /勾选 = 本次取消该分支/)
  assert.equal(question.options[0].description, '勾选 = 本次取消这个分支')
  assert.deepEqual(choice.branches, ['a', 'b'])
})

it('askBranches：全部取消且无新增时报「至少一个运行分支」', async () => {
  const ctx = {
    tools: { register() {} },
    get: () => ({
      ask: async () => ({ answers: [{ id: 'branches', selected: ['a', 'b'] }] }),
    }),
  }
  await assert.rejects(
    () => askBranches(ctx, { title: '多分支', previous: ['a', 'b'] }),
    /至少要有一个运行分支/,
  )
})

it('parseKeepAnswer：默认全选 = 全部保留，输入框新增', () => {
  const choice = parseKeepAnswer(['a', 'b'], { selected: ['a', 'b'], custom: 'c, d' })
  assert.deepEqual(choice.branches, ['a', 'b', 'c', 'd'])
  assert.deepEqual(choice.kept, ['a', 'b'])
  assert.deepEqual(choice.removed, [])
  assert.deepEqual(choice.added, ['c', 'd'])
})

it('parseKeepAnswer：取消勾选 = 移除', () => {
  const choice = parseKeepAnswer(['a', 'b'], { selected: ['a'] })
  assert.deepEqual(choice.branches, ['a'])
  assert.deepEqual(choice.kept, ['a'])
  assert.deepEqual(choice.removed, ['b'])
})

it('parseKeepAnswer：全部取消且无新增 = 空（由调用方报错）', () => {
  const choice = parseKeepAnswer(['a'], { selected: [] })
  assert.deepEqual(choice.branches, [])
})

it('parseRunConfigAnswer：变量只认白名单，空值不覆盖', () => {
  const choice = parseRunConfigAnswer(
    { previous: ['main'], showBranches: true, variables: [{ key: 'A' }, { key: 'B', encrypted: true }] },
    { selected: ['main'], custom: 'feat', envs: { A: '1', B: '', UNKNOWN: 'x' }, comment: '发版' },
  )
  assert.deepEqual(choice.branches?.branches, ['main', 'feat'])
  assert.deepEqual(choice.envs, { A: '1' })
  assert.equal(choice.comment, '发版')
})

it('parseRunConfigAnswer：不显示分支时不要求分支；变量全空 = 不覆盖；备注清空 = 空串', () => {
  const choice = parseRunConfigAnswer(
    { previous: [], showBranches: false, variables: [{ key: 'A' }] },
    { envs: {}, comment: '  ' },
  )
  assert.equal(choice.branches, undefined)
  assert.deepEqual(choice.envs, {})
  assert.equal(choice.comment, '')

  const untouched = parseRunConfigAnswer(
    { previous: [], showBranches: false, variables: [] },
    { envs: {}, comment: '预发布版本' },
  )
  assert.equal(untouched.comment, '预发布版本')

  const absent = parseRunConfigAnswer(
    { previous: [], showBranches: false, variables: [] },
    { envs: {} },
  )
  assert.equal(absent.comment, undefined)
})

it('parseRunConfigAnswer：显示分支但全取消时报错', () => {
  assert.throws(
    () => parseRunConfigAnswer(
      { previous: ['main'], showBranches: true, variables: [] },
      { selected: [], custom: '' },
    ),
    /至少要有一个运行分支/,
  )
})
