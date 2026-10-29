import type { AskBranchesOptions, RunConfigOptions } from '../src/prompt.js'
import type { Project, RunRecord, ToolSpec, WatchHooks } from '../src/types.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { resolveProject } from '../src/project.js'
import { jittered, nextPollInterval, Runner, suggestWaitSec, waitAbortReason } from '../src/runner.js'
import { saveRecord } from '../src/state.js'
import { buildToolDefinitions as buildToolDefinitionsTyped } from '../src/tool-defs.js'

// 测试桩只实现用到的成员（Runner / ToolDefs 的一部分），类型放宽集中在这一行。
// eslint-disable-next-line ts/no-explicit-any -- 桩对象是部分实现，无法满足完整依赖类型
const buildToolDefinitions = (deps: any): any => buildToolDefinitionsTyped(deps)

const defineTool = (options: ToolSpec): ToolSpec => options

let root: string
let tools: ToolSpec[]
let runner: Runner

function execFor(cwd = root) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
}

/** userQuestions 桩：分支弹窗测试用（返回固定答案）。 */
function ctxWithConfirm(answer = '阻塞等待到结束') {
  return {
    tools: { register() {} },
    get: (name: string) => (name === 'userQuestions'
      ? { ask: async () => ({ answers: [{ id: 'block', selected: [answer] }] }) }
      : undefined),
  }
}

function tool(name: string) {
  const found = tools.find((t: ToolSpec) => t.name === name)
  assert.ok(found, `missing tool ${name}`)
  return found
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cicd-tools-'))
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'cicd.json'), JSON.stringify({
    defaults: { timeoutSec: 30, logTailLines: 50 },
    pipelines: {
      'ping': { type: 'shell', title: 'ping', environment: 'test', tier: 'testing', command: 'node -e "console.log(\'ping-ok\')"' },
      'boom': { type: 'shell', title: 'boom', command: 'node -e "console.log(\'boom\'); process.exit(3)"' },
      'slow': { type: 'shell', title: 'slow', command: 'node -e "setTimeout(()=>{}, 5000)"' },
      'guarded': { type: 'shell', title: 'guarded', command: 'node -e "console.log(\'guarded\')"', confirm: true },
      'multibranch': { type: 'yunxiao', title: '多分支', environment: 'test', tier: 'testing', organizationId: 'ORG', pipelineId: 'P3', tokenEnv: 'YUNXIAO_TOKEN' },
      'auto-config': { type: 'yunxiao', title: '自动运行配置', organizationId: 'ORG', pipelineId: 'P8', tokenEnv: 'YUNXIAO_TOKEN', runConfig: true },
    },
  }, null, 2), 'utf8')

  runner = new Runner()
  tools = buildToolDefinitions({ defineTool, runner, options: {}, ctx: ctxWithConfirm() })
})

afterAll(() => {
  runner.dispose()
  rmSync(root, { recursive: true, force: true })
})

function runIdOf(text: string) {
  return text.match(/runId:\s+([\w.-]+)/)?.[1] ?? ''
}

it('注册了七个工具', () => {
  assert.deepEqual(tools.map((t: ToolSpec) => t.name).sort(), [
    'cicd_cancel',
    'cicd_conflict',
    'cicd_list',
    'cicd_logs',
    'cicd_run',
    'cicd_status',
    'cicd_vars',
  ])
})

it('cicd_list 列出配置和最近状态', async () => {
  const result = await tool('cicd_list').execute({}, execFor())
  assert.match(result.text, /ping/)
  assert.match(result.text, /boom/)
  assert.match(result.text, /\[test\]/)
  assert.match(result.text, /流水线：6 条/)
})

it('cicd_run 输出环境元数据', async () => {
  const run = await tool('cicd_run').execute({ pipeline: 'ping' }, execFor())
  assert.match(run.text, /environment: test/)
})

it('run → wait → logs 全链路', async () => {
  const run = await tool('cicd_run').execute({ pipeline: 'ping' }, execFor())
  const runId = runIdOf(run.text)
  assert.ok(runId, run.text)

  const project = resolveProject(execFor(), {})
  const { record } = await runner.wait(project, { runId })
  assert.equal(record.status, 'succeeded')

  const logs = await tool('cicd_logs').execute({ runId }, execFor())
  assert.match(logs.text, /ping-ok/)
})

it('失败退出码与状态', async () => {
  const run = await tool('cicd_run').execute({ pipeline: 'boom' }, execFor())
  const runId = runIdOf(run.text)
  const project = resolveProject(execFor(), {})
  const { record } = await runner.wait(project, { runId })
  assert.equal(record.status, 'failed')
  assert.equal(record.exitCode, 3)
})

it('runner.cancel 标记 canceledByUser（用户主动取消不再唤醒）', async () => {
  const project = resolveProject(execFor(), {})
  const run = await runner.run(project, 'slow', {})
  const canceled = await runner.cancel(project, { runId: run.runId })
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.canceledByUser, true)
})

it('runner.status：本地已取消的记录不会被平台 FAIL 覆盖', async () => {
  const project = resolveProject(execFor(), {})
  const record = {
    runId: 'cancel-sticky-1',
    pipeline: 'guarded',
    title: 'guarded',
    type: 'shell',
    status: 'canceled',
    startedAt: new Date().toISOString(),
    rawStatus: 'RUNNING',
    note: '用户取消',
  }
  saveRecord(project.runsDir, record as RunRecord)
  const current = await runner.status(project, { runId: record.runId })
  assert.equal(current.status, 'canceled')
})

it('confirm 门禁：未确认必须拒绝', async () => {
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'guarded' }, execFor()),
    /确认/,
  )
  const ok = await tool('cicd_run').execute({ pipeline: 'guarded', confirm: true }, execFor())
  assert.match(ok.text, /runId/)
})

it('cicd_status 可按流水线查最近一次', async () => {
  const result = await tool('cicd_status').execute({ pipeline: 'ping' }, execFor())
  assert.match(result.text, /ping/)
  assert.match(result.text, /succeeded/)
})

it('未知流水线报错', async () => {
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'nope' }, execFor()),
    /没有名为/,
  )
})

it('没有配置时 list 返回安装指引而不是报错', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-cicd-empty-'))
  try {
    const result = await tool('cicd_list').execute({}, execFor(empty))
    assert.match(result.text, /还没有流水线配置/)
    assert.match(result.text, /cicd\.json/)
  }
  finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

it('没有会话 cwd 时明确报错', async () => {
  await assert.rejects(
    () => tool('cicd_list').execute({}, { signal: new AbortController().signal }),
    /项目目录/,
  )
})

it('runner.wait 返回终态、轮询次数与耗时', async () => {
  const project = resolveProject(execFor(), {})
  const run = await runner.run(project, 'ping', {})
  const { record, meta } = await runner.wait(project, { runId: run.runId, timeoutSec: 20 })
  assert.equal(record.status, 'succeeded')
  assert.equal(meta.timedOut, false)
  assert.ok(meta.polls >= 1, `polls=${meta.polls}`)
  assert.ok(meta.elapsedMs >= 0)
  assert.equal(meta.lastError, '')
})

it('同一个 runId 的并发 wait 共用一次轮询', async () => {
  const project = resolveProject(execFor(), {})
  const run = await runner.run(project, 'ping', {})
  const [a, b] = await Promise.all([
    runner.wait(project, { runId: run.runId, timeoutSec: 20 }),
    runner.wait(project, { runId: run.runId, timeoutSec: 20 }),
  ])
  assert.equal(a.record.status, 'succeeded')
  assert.equal(b.meta, a.meta)
})

it('轮询退避：递增、封顶、抖动有界', () => {
  assert.equal(nextPollInterval(2_000), 3_200)
  assert.equal(nextPollInterval(14_000), 15_000)
  let d = 2_000
  for (let i = 0; i < 12; i += 1) {
    d = nextPollInterval(d)
    assert.ok(d >= 2_000 && d <= 15_000, `d=${d}`)
  }
  assert.equal(jittered(1_000, { random: () => 0.5 }), 1_000)
  assert.equal(jittered(1_000, { random: () => 1 }), 1_150)
  assert.equal(jittered(1_000, { random: () => 0 }), 850)
})

it('等待预算：无历史 180s，按上次耗时估算并夹在 60~300s', () => {
  assert.equal(suggestWaitSec(0), 180)
  assert.equal(suggestWaitSec(10_000), 60)
  assert.equal(suggestWaitSec(60_000), 95)
  assert.equal(suggestWaitSec(240_000), 300)
  assert.equal(suggestWaitSec(10 * 60_000), 300)
})

it('wait 预算来源：不传按历史/默认，传了按参数', async () => {
  const project = resolveProject(execFor(), {})
  const run = await runner.run(project, 'ping', {})
  const { meta } = await runner.wait(project, { runId: run.runId })
  assert.ok(meta.budgetSec >= 60 && meta.budgetSec <= 300, `budget=${meta.budgetSec}`)
  assert.ok(['history', 'default'].includes(meta.budgetSource), meta.budgetSource)

  const run2 = await runner.run(project, 'ping', {})
  const { meta: explicitMeta } = await runner.wait(project, { runId: run2.runId, timeoutSec: 20 })
  assert.equal(explicitMeta.budgetSource, 'param')
  assert.equal(explicitMeta.budgetSec, 20)
})

it('历史记录没写 durationMs 时用起止时间兜底估算', async () => {
  const project = resolveProject(execFor(), {})
  const now = Date.now()
  saveRecord(project.runsDir, {
    runId: '20260101-000000-ping-hist',
    pipeline: 'ping',
    title: 'ping',
    type: 'shell',
    status: 'succeeded',
    startedAt: new Date(now - 30_000).toISOString(),
    finishedAt: new Date(now - 10_000).toISOString(),
    projectRoot: project.root,
  })

  const run = await runner.run(project, 'ping', {})
  const { meta } = await runner.wait(project, { runId: run.runId })
  assert.equal(meta.budgetSource, 'history')
  assert.equal(meta.budgetSec, 60) // 20s × 1.25 + 20 = 45，夹到下限 60
})

it('等待中的错误策略：不可重试立即停，可重试连续 4 次停', () => {
  assert.equal(waitAbortReason({ errorStreak: 0 }), '')
  assert.equal(waitAbortReason({ errorStreak: 1, retryable: false }), 'fatal')
  assert.equal(waitAbortReason({ errorStreak: 1, retryable: true }), '')
  assert.equal(waitAbortReason({ errorStreak: 3, retryable: true }), '')
  assert.equal(waitAbortReason({ errorStreak: 4, retryable: true }), 'gave-up')
})

it('cicd_run interactive：弹窗增减分支后以 replace 触发', async () => {
  let captured
  const stubRunner = {
    run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
      captured = opts.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
        branches: ['feat-a', 'feat-new'],
      }
    },
  }
  const askService = {
    ask: async () => ({
      answers: [
        { id: 'branches', selected: ['feat-b'], custom: 'feat-new' },
      ],
    }),
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: {
      tools: { register() {} },
      get: (name: string) => (name === 'userQuestions' ? askService : undefined),
    },
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a', 'feat-b'] }),
  })
  const runTool = stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
  const result = await runTool.execute({ pipeline: 'multibranch', interactive: true }, execFor())
  assert.deepEqual(captured, { branches: ['feat-a', 'feat-new'], branchMode: 'replace' })
  assert.match(result.text, /feat-a/)
})

it('cicd_run interactive + preview：只返回选择，不触发', async () => {
  let called = false
  const stubRunner = {
    run: async () => {
      called = true
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: {
      tools: { register() {} },
      get: (name: string) => (name === 'userQuestions'
        ? { ask: async () => ({ answers: [{ id: 'branches', custom: 'feat-x' }] }) }
        : undefined),
    },
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a'] }),
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', interactive: true, preview: true }, execFor())
  assert.equal(called, false)
  assert.match(result.text, /preview/)
  assert.match(result.text, /feat-x/)
})

it('cicd_run interactive：没有 userQuestions 服务时给明确提示', async () => {
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: { run: async () => { throw new Error('should not run') } },
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a'] }),
  })
  await assert.rejects(
    () => stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
      .execute({ pipeline: 'multibranch', interactive: true }, execFor()),
    /userQuestions/,
  )
})

it('cicd_run interactive：非多分支流水线直接报错', async () => {
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: { run: async () => { throw new Error('should not run') } },
    options: {},
    ctx: { tools: { register() {} }, get: () => ({ ask: async () => ({ answers: [] }) }) },
    branchState: async () => ({ isBranchMode: false, previous: [] }),
  })
  await assert.rejects(
    () => stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
      .execute({ pipeline: 'multibranch', interactive: true }, execFor()),
    /不是多分支模式/,
  )
})

it('cicd_run interactive：优先使用自定义 branchDialog', async () => {
  let captured
  let dialogUsed = false
  let dialogOptions
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
        branches: ['feat-x'],
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: true, previous: ['a'] }),
    branchDialog: async (options: AskBranchesOptions) => {
      dialogUsed = true
      dialogOptions = options
      return { branches: ['feat-x'], kept: ['feat-x'], removed: [], added: ['feat-x'] }
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', interactive: true }, execFor())
  assert.equal(dialogUsed, true)
  assert.equal(dialogOptions!.environment, 'test')
  assert.equal(dialogOptions!.tier, 'testing')
  assert.deepEqual(captured, { branches: ['feat-x'], branchMode: 'replace' })
})

it('cicd_run 多分支：未传 branches 时默认弹窗', async () => {
  let captured
  let dialogUsed = false
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
        branches: ['a'],
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: true, previous: ['a'] }),
    branchDialog: async () => {
      dialogUsed = true
      return { branches: ['a'], kept: ['a'], removed: [], added: [] }
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'multibranch' }, execFor())
  assert.equal(dialogUsed, true)
  assert.deepEqual(captured, { branches: ['a'], branchMode: 'replace' })
})

it('cicd_run 多分支：自动弹窗失败时取消触发并报错', async () => {
  let captured
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: true, previous: ['a'] }),
    branchDialog: async () => { throw new Error('当前环境没有可用的交互提问服务（ctx.userQuestions）') },
  })
  await assert.rejects(
    () => stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'multibranch' }, execFor()),
    /分支选择框不可用/,
  )
  assert.equal(captured, undefined)
})

it('cicd_run 多分支：本地记忆过滤取消的分支，但保留云效新加的分支', async () => {
  writeFileSync(
    join(root, '.dsh', 'cicd-branches.json'),
    JSON.stringify({ multibranch: { selected: ['feat-a'], removed: ['feat-b'] } }),
    'utf8',
  )
  let captured
  let dialogPrevious: string[] = []
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    // 云效侧：feat-b 仍在 + 别人新加了 feat-c
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a', 'feat-b', 'feat-c'] }),
    branchDialog: async (options: AskBranchesOptions) => {
      dialogPrevious = options.previous
      return { branches: ['feat-a', 'feat-c'], kept: ['feat-a', 'feat-c'], removed: [], added: [] }
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'multibranch' }, execFor())
  assert.deepEqual(dialogPrevious, ['feat-a', 'feat-c'])
  assert.deepEqual(captured!.branches, ['feat-a', 'feat-c'])
  const saved = JSON.parse(readFileSync(join(root, '.dsh', 'cicd-branches.json'), 'utf8'))
  assert.deepEqual(saved.multibranch, { selected: ['feat-a', 'feat-c'], removed: ['feat-b'] })
})

it('cicd_run interactive:false 不再跳过弹窗（兼容旧参数）', async () => {
  let dialogUsed = false
  let captured
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a'] }),
    branchDialog: async () => {
      dialogUsed = true
      return { branches: ['feat-a'], kept: ['feat-a'], removed: [], added: [] }
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', interactive: false }, execFor())
  assert.equal(dialogUsed, true)
  assert.deepEqual(captured, { branches: ['feat-a'], branchMode: 'replace' })
})

it('cicd_run reusePrevious:true 跳过弹窗，直接用上次集合', async () => {
  writeFileSync(
    join(root, '.dsh', 'cicd-branches.json'),
    JSON.stringify({ multibranch: { selected: ['feat-a'], removed: ['feat-b'] } }),
    'utf8',
  )
  let dialogUsed = false
  let captured
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    branchState: async () => ({ isBranchMode: true, previous: ['feat-a', 'feat-b'] }),
    branchDialog: async () => {
      dialogUsed = true
      return { branches: [], kept: [], removed: [], added: [] }
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', reusePrevious: true }, execFor())
  assert.equal(dialogUsed, false)
  assert.deepEqual(captured, { branches: ['feat-a'], branchMode: 'replace' })
})

it('cicd_run 触发后交给后台 watcher', async () => {
  let watched = ''
  const stubRunner = {
    run: async () => ({
      runId: 'r-watch',
      pipeline: 'ping',
      title: 'ping',
      type: 'shell',
      status: 'running',
      startedAt: new Date().toISOString(),
    }),
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    watch: (_project: Project, record: RunRecord) => { watched = record.runId },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'ping' }, execFor())
  assert.equal(watched, 'r-watch')
})

it('cicd_run 会把 branches / branchMode 合进 params', async () => {
  let captured
  const stubRunner = {
    run: async (_project: Project, _name: string, options: { params?: Record<string, unknown> }) => {
      captured = options.params
      return {
        runId: 'r1',
        pipeline: 'ping',
        title: 'ping',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
        branches: ['feat-x'],
      }
    },
  }
  const stubTools = buildToolDefinitions({ defineTool, runner: stubRunner, options: {} })
  const runTool = stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
  const result = await runTool.execute(
    { pipeline: 'ping', branches: ['feat-x'], branchMode: 'replace' },
    execFor(),
  )
  assert.deepEqual(captured, { branches: ['feat-x'], branchMode: 'replace' })
  assert.match(result.text, /branches: feat-x/)
})

it('cicd_run 返回后明确结束本轮：不等待、不提 block', async () => {
  const run = await tool('cicd_run').execute({ pipeline: 'ping' }, execFor())
  assert.match(run.text, /触发完成，本轮到此结束/)
  assert.match(run.text, /不要等待/)
  assert.match(run.text, /cicd_status/)
  assert.doesNotMatch(run.text, /cicd_wait|block/)
})

it('cicd_run followUp:true 在终态/冲突时唤醒模型，消息带状态和提示', async () => {
  const captured: WatchHooks[] = []
  const messages: Array<{ role: string, content: Array<{ type: string, text: string }>, source: { kind: string } }> = []
  const followTools = buildToolDefinitions({
    defineTool,
    runner,
    options: {},
    watch: (_project: Project, _record: RunRecord, hooks?: WatchHooks) => {
      if (hooks)
        captured.push(hooks)
    },
  })
  const runTool = followTools.find((t: ToolSpec) => t.name === 'cicd_run')
  const exec = {
    ...execFor(),
    agent: {
      ...execFor().agent,
      followup: (message: typeof messages[number]) => messages.push(message),
    },
  }
  const result = await runTool.execute({ pipeline: 'ping', followUp: true }, exec)
  assert.match(result.text, /自动唤醒/)
  assert.equal(captured.length, 1)

  const finalRecord = {
    runId: 'follow-1',
    pipeline: 'ping',
    title: 'ping',
    type: 'shell',
    status: 'failed',
    startedAt: new Date().toISOString(),
    durationMs: 1_200,
    progress: '阶段 1/2 · 构建（失败）',
  } as RunRecord
  captured[0].onTerminal?.(finalRecord, '分支合并冲突')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].source.kind, 'dsh-cicd')
  assert.match(messages[0].content[0].text, /后台通知/)
  assert.match(messages[0].content[0].text, /失败/)
  assert.match(messages[0].content[0].text, /分支合并冲突/)
  assert.match(messages[0].content[0].text, /不是用户的新发言/)

  const conflictRecord = {
    ...finalRecord,
    status: 'running',
    durationMs: undefined,
    progress: '阶段 1/3 · 分支集成（运行中）',
    note: 'Merge conflicted, job paused',
  } as RunRecord
  captured[0].onConflict?.(conflictRecord)
  assert.equal(messages.length, 2)
  assert.match(messages[1].content[0].text, /合并冲突/)
  assert.match(messages[1].content[0].text, /cicd_conflict/)
  assert.match(messages[1].content[0].text, /不是终态/)
})

it('cicd_run followUp:true 在旧运行时降级为提示', async () => {
  const run = await tool('cicd_run').execute({ pipeline: 'ping', followUp: true }, execFor())
  assert.match(run.text, /不支持自动唤醒/)
})

it('cicd_run 云效运行参数：comment/envs/tags/repoBranches/artifacts 映射成平台 params', async () => {
  let captured: Record<string, unknown> | undefined
  const stubRunner = {
    run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
      captured = opts.params
      return {
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: false, previous: [] }),
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({
    pipeline: 'multibranch',
    comment: 'deploy from chat',
    envs: { APP_ENV: 'test', RETRIES: 2, DEBUG: true },
    tags: { 'https://codeup.aliyun.com/demo/repo.git': '1.0' },
    repoBranches: { 'https://codeup.aliyun.com/demo/repo.git': 'release' },
    artifacts: {
      pipeline: { 3184679: '12' },
      acr: { 'registry.example.com/app': 'tag-1' },
      packages: { 'generic/repo/pkg': '1.2.3' },
    },
  }, execFor())
  assert.deepEqual(captured, {
    comment: 'deploy from chat',
    envs: { APP_ENV: 'test', RETRIES: '2', DEBUG: 'true' },
    runningTags: { 'https://codeup.aliyun.com/demo/repo.git': '1.0' },
    runningBranchs: { 'https://codeup.aliyun.com/demo/repo.git': 'release' },
    runningPipelineArtifacts: { 3184679: '12' },
    runningAcrArtifacts: { 'registry.example.com/app': 'tag-1' },
    runningPackagesArtifacts: { 'generic/repo/pkg': '1.2.3' },
  })
})

it('cicd_run 云效运行参数：命名参数覆盖 params 里的同名 key', async () => {
  let captured: Record<string, unknown> | undefined
  const stubRunner = {
    run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
      captured = opts.params
      return {
        runId: 'r2',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }
    },
  }
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: stubRunner,
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: false, previous: [] }),
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run').execute({
    pipeline: 'multibranch',
    params: { comment: 'old', envs: { A: '1' } },
    comment: 'new',
    envs: { B: '2' },
  }, execFor())
  assert.deepEqual(captured, { comment: 'new', envs: { B: '2' } })
})

it('cicd_run 云效运行参数：shell 流水线明确报错', async () => {
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'ping', comment: 'x' }, execFor()),
    /只支持云效/,
  )
})

it('cicd_run 云效运行参数：形状不合法时给出可照做的错误', async () => {
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'multibranch', envs: ['x'] }, execFor()),
    /envs 必须是对象/,
  )
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'multibranch', envs: { A: { nested: 1 } } }, execFor()),
    /envs\.A 必须是/,
  )
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'multibranch', artifacts: { unknown: { a: 'b' } } }, execFor()),
    /只支持 pipeline \/ acr \/ packages/,
  )
})

it('cicd_vars 只列变量名，不输出值', async () => {
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([
        { key: 'NPM_TOKEN', encrypted: true, masked: true },
        { key: 'VITE_BASE_URL', description: '前端地址', runningConfig: true },
      ]),
    },
    options: {},
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_vars')
    .execute({ pipeline: 'multibranch' }, execFor())
  assert.match(result.text, /NPM_TOKEN/)
  assert.match(result.text, /值不可读/)
  assert.match(result.text, /VITE_BASE_URL/)
  assert.match(result.text, /前端地址/)
  assert.doesNotMatch(result.text, /secret|pt-/)
})

it('cicd_vars：shell 流水线明确报错', async () => {
  await assert.rejects(
    () => tool('cicd_vars').execute({ pipeline: 'ping' }, execFor()),
    /只有云效/,
  )
})

it('cicd_run 触发后提示运行变量（未覆盖用默认值）', async () => {
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      run: async () => ({
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
        variables: [
          { key: 'VITE_BASE_URL' },
          { key: 'NPM_TOKEN', encrypted: true },
        ],
      }),
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch' }, execFor())
  assert.match(result.text, /运行变量：2 个/)
  assert.match(result.text, /使用平台默认值/)
  assert.match(result.text, /cicd_vars/)
  assert.doesNotMatch(result.text, /secret|pt-/)
})

it('cicd_run runConfig:true 弹运行配置，变量值进参数但不回显', async () => {
  let dialogOptions: { variables: Array<{ key: string }> } | undefined
  let captured: Record<string, unknown> | undefined
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([{ key: 'A' }, { key: 'B', encrypted: true }]),
      run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
        captured = opts.params
        return {
          runId: 'r1',
          pipeline: 'multibranch',
          title: '多分支',
          type: 'yunxiao',
          status: 'running',
          startedAt: new Date().toISOString(),
          overriddenVariables: ['A'],
        }
      },
    },
    options: {},
    ctx: { tools: { register() {} } },
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: (options: RunConfigOptions) => {
      dialogOptions = options
      return Promise.resolve({ envs: { A: 'value-a' }, comment: '发版' })
    },
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', runConfig: true }, execFor())
  assert.equal(dialogOptions?.variables.length, 2)
  assert.deepEqual(captured, { envs: { A: 'value-a' }, comment: '发版' })
  assert.match(result.text, /变量覆盖：A/)
  assert.doesNotMatch(result.text, /value-a/)
})

it('cicd_run 把用户话里的备注预填到弹窗，弹窗留空时保留', async () => {
  let dialogOptions: RunConfigOptions | undefined
  let captured: Record<string, unknown> | undefined
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([]),
      run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
        captured = opts.params
        return {
          runId: 'r1',
          pipeline: 'auto-config',
          title: '自动运行配置',
          type: 'yunxiao',
          status: 'running',
          startedAt: new Date().toISOString(),
        }
      },
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: (options: RunConfigOptions) => {
      dialogOptions = options
      return Promise.resolve({ envs: {} })
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'auto-config', comment: '预发布版本' }, execFor())
  assert.equal(dialogOptions?.comment, '预发布版本')
  assert.equal(captured?.comment, '预发布版本')
})

it('cicd_run 弹窗清空备注时不再发送', async () => {
  let captured: Record<string, unknown> | undefined
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([]),
      run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
        captured = opts.params
        return {
          runId: 'r1',
          pipeline: 'auto-config',
          title: '自动运行配置',
          type: 'yunxiao',
          status: 'running',
          startedAt: new Date().toISOString(),
        }
      },
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: () => Promise.resolve({ envs: {}, comment: '' }),
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'auto-config', comment: '预发布版本' }, execFor())
  assert.equal(captured?.comment, undefined)
})

it('cicd_run 按配置 runConfig:true 弹窗；runConfig:false 且无可确认分支时不弹', async () => {
  let calls = 0
  const makeTools = () => buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([]),
      run: async () => ({
        runId: 'r1',
        pipeline: 'auto-config',
        title: '自动运行配置',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }),
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: () => {
      calls++
      return Promise.resolve({ envs: {} })
    },
  })
  const open = makeTools()
  await open.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'auto-config' }, execFor())
  assert.equal(calls, 1)

  const skip = makeTools()
  await skip.find((t: ToolSpec) => t.name === 'cicd_run').execute({ pipeline: 'auto-config', runConfig: false }, execFor())
  assert.equal(calls, 1)
})

it('cicd_run runConfig 只支持云效流水线', async () => {
  await assert.rejects(
    () => tool('cicd_run').execute({ pipeline: 'ping', runConfig: true }, execFor()),
    /只支持云效/,
  )
})

it('cicd_run 运行配置取消时不触发', async () => {
  let ran = false
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([]),
      run: async () => {
        ran = true
        throw new Error('should not run')
      },
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: () => Promise.reject(new Error('用户取消了本次运行')),
  })
  await assert.rejects(
    () => stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
      .execute({ pipeline: 'multibranch', runConfig: true }, execFor()),
    /取消/,
  )
  assert.equal(ran, false)
})

it('cicd_run runConfig + preview：只回配置，不回显变量值', async () => {
  let ran = false
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([{ key: 'SECRET' }]),
      run: async () => {
        ran = true
        return {}
      },
    },
    options: {},
    branchState: async () => ({ isBranchMode: false, previous: [] }),
    runDialog: () => Promise.resolve({ envs: { SECRET: 'super-secret' }, comment: '备注' }),
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', runConfig: true, preview: true }, execFor())
  assert.equal(ran, false)
  assert.match(result.text, /变量覆盖：SECRET/)
  assert.match(result.text, /preview/)
  assert.doesNotMatch(result.text, /super-secret/)
})

it('cicd_run runConfig 但 client 不在线：分支回退，变量用默认值并提示', async () => {
  let branchDialogCalled = false
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([{ key: 'A' }]),
      run: async () => ({
        runId: 'r1',
        pipeline: 'multibranch',
        title: '多分支',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }),
    },
    options: {},
    branchState: async () => ({ isBranchMode: true, previous: ['main'] }),
    branchDialog: async () => {
      branchDialogCalled = true
      return { branches: ['main'], kept: ['main'], removed: [], added: [] }
    },
  })
  const result = await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'multibranch', runConfig: true }, execFor())
  assert.equal(branchDialogCalled, true)
  assert.match(result.text, /运行配置弹窗不可用/)
  assert.match(result.text, /使用云效默认值/)
})

it('cicd_run runConfig:false 只跳过变量，分支仍然确认', async () => {
  let dialogOptions: RunConfigOptions | undefined
  let captured: Record<string, unknown> | undefined
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => {
        throw new Error('runConfig:false 时不应读取变量')
      },
      run: async (_project: Project, _name: string, opts: { params?: Record<string, unknown> }) => {
        captured = opts.params
        return {
          runId: 'r1',
          pipeline: 'auto-config',
          title: '自动运行配置',
          type: 'yunxiao',
          status: 'running',
          startedAt: new Date().toISOString(),
        }
      },
    },
    options: {},
    branchState: async () => ({ isBranchMode: true, previous: ['main'] }),
    runDialog: (options: RunConfigOptions) => {
      dialogOptions = options
      return Promise.resolve({
        branches: { branches: ['main'], kept: ['main'], removed: [], added: [] },
        envs: {},
      })
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'auto-config', runConfig: false, branches: ['main'] }, execFor())
  assert.equal(dialogOptions?.showBranches, true)
  assert.deepEqual(dialogOptions?.variables, [])
  assert.equal(dialogOptions?.showComment, false)
  assert.deepEqual(dialogOptions?.previous, ['main'])
  assert.deepEqual(captured, { branches: ['main'], branchMode: 'replace' })
})

it('cicd_run 开了 runConfig 时显式 branches 只做预选，不跳过确认', async () => {
  let called = false
  let dialogOptions: RunConfigOptions | undefined
  const stubTools = buildToolDefinitions({
    defineTool,
    runner: {
      variables: async () => ([]),
      run: async () => ({
        runId: 'r1',
        pipeline: 'auto-config',
        title: '自动运行配置',
        type: 'yunxiao',
        status: 'running',
        startedAt: new Date().toISOString(),
      }),
    },
    options: {},
    branchState: async () => ({ isBranchMode: true, previous: ['main'] }),
    runDialog: (options: RunConfigOptions) => {
      called = true
      dialogOptions = options
      return Promise.resolve({
        branches: { branches: ['feat-x'], kept: [], removed: [], added: ['feat-x'] },
        envs: {},
      })
    },
  })
  await stubTools.find((t: ToolSpec) => t.name === 'cicd_run')
    .execute({ pipeline: 'auto-config', branches: ['feat-x'] }, execFor())
  assert.equal(called, true)
  assert.equal(dialogOptions?.showBranches, true)
  assert.deepEqual(dialogOptions?.previous, ['feat-x'])
})

it('runner：envs 值不落运行记录，只保留变量名', async () => {
  const project = resolveProject(execFor(), {})
  const run = await runner.run(project, 'ping', { params: { envs: { SECRET: 'super-secret' }, comment: '备注' } })
  const raw = readFileSync(join(project.runsDir, `${run.runId}.json`), 'utf8')
  assert.doesNotMatch(raw, /super-secret/)
  assert.deepEqual(run.overriddenVariables, ['SECRET'])
  assert.equal(run.params?.comment, '备注')
  assert.equal((run.params as Record<string, unknown>)?.envs, undefined)
})
