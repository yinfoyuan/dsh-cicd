import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Pipeline, RunRecord, YunxiaoPipeline } from '../src/types.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { afterAll, beforeAll, it } from 'vitest'
import { createProvider as createProviderTyped, findManualGate, getYunxiaoBranchState, isRetryable, mergeBranches, parsePipelineVariables, parseSourceBranches, pendingConflict, summarizeStages, triggerModeLabel, waitingFor } from '../src/providers.js'

/** 测试里的流水线只写用到的字段，这里按 Pipeline 收窄。 */
function createProvider(pipeline: Partial<Pipeline>): ReturnType<typeof createProviderTyped> {
  return createProviderTyped(pipeline as Pipeline)
}

/** 测试只关心 externalId，其余字段由 provider 读取前兜底。 */
const record = (externalId: string): RunRecord => ({ externalId } as RunRecord)

process.env.YUNXIAO_TOKEN = 'pt-test'

let server: Server
let baseUrl: string
let postBodies: Array<{ params: string }> = []
let lastRunPayload: Record<string, unknown> | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    // eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
    req.on('end', () => {
      const send = (status: number, text: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(text)
      }

      // ---- 云效 ----
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P1/runs') {
        assert.equal(req.headers['x-yunxiao-token'], 'pt-test')
        const payload = JSON.parse(body || '{}')
        assert.equal(typeof payload.params, 'string', 'params 必须是 JSON 字符串')
        assert.deepEqual(JSON.parse(payload.params), { envs: { A: '1' } })
        // 真实接口返回裸整数
        return send(200, '42', { 'content-type': 'text/plain' })
      }
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P8/runs') {
        return send(200, '45', { 'content-type': 'text/plain' })
      }
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P5/runs') {
        lastRunPayload = JSON.parse(JSON.parse(body || '{}').params)
        return send(200, '44', { 'content-type': 'text/plain' })
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P1/runs/42') {
        return send(200, JSON.stringify({
          status: 'FAIL',
          stages: [{ stageInfo: { jobs: [{ id: 7, name: 'build', status: 'FAIL' }] } }],
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P1/runs/42/job/7/log') {
        return send(200, JSON.stringify({ content: 'boom log', last: 1, more: false }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P11/runs?page=1&perPage=5') {
        return send(200, JSON.stringify([
          {
            pipelineRunId: 101,
            status: 'SUCCESS',
            startTime: Date.UTC(2026, 9, 29, 1, 0, 0),
            endTime: Date.UTC(2026, 9, 29, 1, 3, 0),
            triggerMode: 4,
            creatorAccountId: 'acc1',
          },
          {
            pipelineRunId: 102,
            status: 'RUNNING',
            startTime: Date.UTC(2026, 9, 29, 2, 0, 0),
            triggerMode: 1,
          },
        ]))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P12/runs/1') {
        return send(200, JSON.stringify({
          status: 'RUNNING',
          stages: [
            { name: '构建', stageInfo: { status: 'SUCCESS', jobs: [{ id: 8, status: 'SUCCESS' }] } },
            {
              name: '审批',
              stageInfo: {
                status: 'SWITCH_MANUAL',
                jobs: [{
                  id: 9,
                  name: '人工卡点',
                  status: 'RUNNING',
                  actions: [{ type: 'PassPipelineValidate', disable: false }],
                }],
              },
            },
          ],
        }))
      }
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P12/pipelineRuns/1/jobs/9/pass') {
        return send(200, 'true', { 'content-type': 'text/plain' })
      }
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P12/pipelineRuns/1/jobs/9/refuse') {
        return send(200, 'true', { 'content-type': 'text/plain' })
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P13/runs/1') {
        return send(200, JSON.stringify({ status: 'RUNNING', stages: [] }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P14/runs/1') {
        return send(200, JSON.stringify({
          status: 'RUNNING',
          stages: [{
            name: '审批',
            stageInfo: {
              status: 'SWITCH_MANUAL',
              jobs: [{ id: 10, name: '人工卡点', actions: [{ type: 'PassPipelineValidate', disable: true }] }],
            },
          }],
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P10/runs/1') {
        return send(200, JSON.stringify({
          status: 'RUNNING',
          stages: [
            { name: '构建', stageInfo: { status: 'SUCCESS', jobs: [{ id: 1, status: 'SUCCESS' }] } },
            { name: '审批', stageInfo: { status: 'SWITCH_MANUAL', jobs: [{ id: 2, status: 'INIT' }] } },
            { name: '部署', stageInfo: { status: 'INIT', jobs: [{ id: 3, status: 'INIT' }] } },
          ],
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P9') {
        return send(200, 'secret-value-not-json')
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P8') {
        return send(200, JSON.stringify({
          name: 'P8',
          pipelineConfig: {
            sources: [{ data: { isBranchMode: false } }],
            settings: JSON.stringify({
              globalParams: [
                { key: 'VITE_BASE_URL', value: 'https://secret.example.com', description: '前端地址', runningConfig: true, encrypted: false, masked: false },
                { key: 'NPM_TOKEN', value: 'pt-super-secret', runningConfig: true, encrypted: true, masked: true },
                { created: true },
              ],
            }),
          },
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P1') {
        return send(200, JSON.stringify({
          name: 'P1',
          pipelineConfig: { sources: [{ data: { isBranchMode: false } }] },
        }))
      }
      if (req.method === 'PUT' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P1/runs/42') {
        return send(200, 'true', { 'content-type': 'text/plain' })
      }

      // ---- 云效：多分支模式 ----
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P3') {
        return send(200, JSON.stringify({
          name: 'P3',
          pipelineConfig: { sources: [{ data: { isBranchMode: true } }] },
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P3/runs/latestPipelineRun') {
        return send(200, JSON.stringify({
          object: {
            globalParams: [{
              key: 'CI_SOURCE_BRANCHES',
              value: JSON.stringify([
                { CI_COMMIT_REF_NAME: 'feat-a' },
                { CI_COMMIT_REF_NAME: 'feat-shared' },
              ]),
            }],
          },
        }))
      }
      if (req.method === 'POST' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P3/runs') {
        postBodies.push(JSON.parse(body || '{}'))
        return send(200, '43', { 'content-type': 'text/plain' })
      }

      // ---- 云效：最近一次没有分支集，回看历史 ----
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P4') {
        return send(200, JSON.stringify({
          name: 'P4',
          pipelineConfig: { sources: [{ data: { isBranchMode: true } }] },
        }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P4/runs/latestPipelineRun') {
        return send(200, JSON.stringify({ object: { globalParams: [] } }))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P4/runs?page=1&perPage=5') {
        return send(200, JSON.stringify([{ pipelineRunId: 100 }]))
      }
      if (req.method === 'GET' && req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P4/runs/100') {
        return send(200, JSON.stringify({
          globalParams: [{
            key: 'CI_SOURCE_BRANCHES',
            value: JSON.stringify([{ CI_COMMIT_REF_NAME: 'feat-history' }]),
          }],
        }))
      }

      // ---- 云效：FAIL 但 job result 是「用户已取消」 ----
      if (req.url === '/oapi/v1/flow/organizations/ORG/pipelines/P6/runs/1') {
        return send(200, JSON.stringify({
          status: 'FAIL',
          stages: [{
            stageInfo: {
              jobs: [{ id: 11, name: 'Git分支管理器', status: 'FAIL', result: '{"message":"用户已取消"}' }],
            },
          }],
        }))
      }

      // ---- 云效：错误分级 ----
      if (req.url === '/oapi/v1/flow/organizations/ORG/pipelines/E1/runs/1') {
        return send(401, JSON.stringify({ error: 'InvalidToken' }))
      }
      if (req.url === '/oapi/v1/flow/organizations/ORG/pipelines/E2/runs/1') {
        return send(500, JSON.stringify({ error: 'boom' }))
      }

      if (req.url === '/unauth')
        return send(401, JSON.stringify({ error: 'InvalidToken' }))
      if (req.url === '/flaky500')
        return send(500, JSON.stringify({ error: 'boom' }))

      send(404, JSON.stringify({ error: `unhandled ${req.method} ${req.url}` }))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

it('云效：触发响应是裸整数，解析成 runId', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P1',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const run = await provider.trigger({ params: { envs: { A: '1' } } })
  assert.equal(run.externalId, '42')
})

it('云效：运行参数原样透传，本次参数覆盖配置默认值', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P5',
    tokenEnv: 'YUNXIAO_TOKEN',
    branchMode: 'off',
    params: { comment: 'from-config', envs: { A: '1' } },
  })
  const run = await provider.trigger({
    params: {
      comment: 'from-tool',
      envs: { B: '2' },
      runningTags: { 'https://codeup.aliyun.com/demo/repo.git': '1.0' },
      runningPipelineArtifacts: { 3184679: '12' },
    },
  })
  assert.equal(run.externalId, '44')
  assert.deepEqual(lastRunPayload, {
    comment: 'from-tool',
    envs: { B: '2' },
    runningTags: { 'https://codeup.aliyun.com/demo/repo.git': '1.0' },
    runningPipelineArtifacts: { 3184679: '12' },
  })
})

it('云效：运行变量只读副本，不包含值', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P8',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const variables = await provider.variables?.()
  assert.deepEqual(variables, [
    { key: 'VITE_BASE_URL', description: '前端地址', runningConfig: true },
    { key: 'NPM_TOKEN', runningConfig: true, encrypted: true, masked: true },
  ])
  assert.doesNotMatch(JSON.stringify(variables), /secret|pt-/)
})

it('云效：触发时带回变量副本（不含值）', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P8',
    tokenEnv: 'YUNXIAO_TOKEN',
    branchMode: 'off',
    params: {},
  })
  const run = await provider.trigger({ params: {} })
  assert.equal(run.externalId, '45')
  assert.equal(run.variables?.length, 2)
  assert.doesNotMatch(JSON.stringify(run), /secret|pt-/)
})

it('云效：变量读取失败时不回显响应体', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P9',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  await assert.rejects(
    () => provider.variables!(),
    (error: Error) => {
      assert.doesNotMatch(error.message, /secret-value/)
      assert.match(error.message, /读取云效运行变量失败/)
      return true
    },
  )
})

it('parsePipelineVariables：只取元数据，value 与无 key 项被忽略', () => {
  const settings = JSON.stringify({
    globalParams: [
      { key: 'A', value: 'secret-a', encrypted: true, runningConfig: true },
      { key: 'B', value: 123, description: '说明' },
      { noKey: true },
      null,
    ],
  })
  assert.deepEqual(parsePipelineVariables(settings), [
    { key: 'A', runningConfig: true, encrypted: true },
    { key: 'B', description: '说明' },
  ])
  assert.deepEqual(parsePipelineVariables('not-json'), [])
  assert.deepEqual(parsePipelineVariables({ globalParams: null }), [])
})

it('云效：FAIL → failed', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P1',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const out = await provider.poll(record('42'))
  assert.equal(out.status, 'failed')
  assert.equal(out.rawStatus, 'FAIL')
  assert.match(String(out.progress), /失败/)
})

it('云效：日志按失败 job 拉取', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P1',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const text = await provider.logs(record('42'))
  assert.match(text, /boom log/)
})

it('云效：取消走 PUT', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P1',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const out = await provider.cancel(record('42'))
  assert.match(String(out.note), /true/)
})

it('云效：SWITCH_MANUAL 识别为等待人工确认', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P10',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const out = await provider.poll(record('1'))
  assert.equal(out.status, 'running')
  assert.match(String(out.progress), /等待人工确认/)
  assert.match(String(out.waiting), /审批/)

  const run = {
    stages: [
      { name: '构建', stageInfo: { status: 'SUCCESS', jobs: [{ status: 'SUCCESS' }] } },
      { name: '审批', stageInfo: { status: 'SWITCH_MANUAL', jobs: [{ status: 'INIT' }] } },
    ],
  }
  assert.match(waitingFor(run), /审批/)
  assert.equal(waitingFor({ stages: [] }), '')
})

it('云效：运行历史映射状态/耗时/触发方式', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P11',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const runs = await provider.runs?.(5)
  assert.equal(runs?.length, 2)
  assert.equal(runs?.[0]?.externalId, '101')
  assert.equal(runs?.[0]?.status, 'succeeded')
  assert.equal(runs?.[0]?.durationMs, 180_000)
  assert.equal(runs?.[0]?.triggerMode, 4)
  assert.equal(runs?.[0]?.creatorAccountId, 'acc1')
  assert.equal(runs?.[1]?.status, 'running')
  assert.equal(triggerModeLabel(4), 'API')
  assert.equal(triggerModeLabel(99), '')
})

it('云效：人工卡点按 actions 定位并 pass/refuse', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P12',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const pass = await provider.approve?.(record('1'), 'pass')
  assert.match(String(pass?.note), /已通过人工卡点/)
  const refuse = await provider.approve?.(record('1'), 'refuse')
  assert.match(String(refuse?.note), /已拒绝人工卡点/)

  const gate = findManualGate({
    stages: [{
      name: '审批',
      stageInfo: {
        status: 'SWITCH_MANUAL',
        jobs: [{ id: 9, name: '人工卡点', actions: [{ type: 'PassPipelineValidate', disable: false }] }],
      },
    }],
  })
  assert.equal(gate?.jobId, 9)
  assert.equal(gate?.canApprove, true)
})

it('云效：没有卡点或没有审批权限时明确报错', async () => {
  const none = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P13',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  await assert.rejects(() => none.approve!(record('1'), 'pass'), /没有等待人工确认的卡点/)

  const denied = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P14',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  await assert.rejects(() => denied.approve!(record('1'), 'pass'), /审批权限/)
})

it('云效：summarizeStages 从 jobs 推断当前阶段', () => {
  const text = summarizeStages({
    stages: [
      { name: '构建', stageInfo: { jobs: [{ status: 'SUCCESS' }, { status: 'SUCCESS' }] } },
      { name: '部署', stageInfo: { jobs: [{ status: 'RUNNING' }, { status: 'INIT' }] } },
    ],
  })
  assert.match(text, /阶段 2\/2/)
  assert.match(text, /部署/)
  assert.match(text, /运行中/)

  const failed = summarizeStages({
    stages: [
      { name: '构建', stageInfo: { jobs: [{ status: 'SUCCESS' }] } },
      { name: '部署', stageInfo: { jobs: [{ status: 'FAIL' }] } },
    ],
  })
  assert.match(failed, /失败/)

  assert.equal(summarizeStages({}), '')
  assert.equal(summarizeStages({ stages: [] }), '')
})

it('错误分级：401 不可重试，500/网络错误可重试', async () => {
  const make = (pipelineId: string, url = baseUrl) => createProvider({
    type: 'yunxiao',
    baseUrl: url,
    organizationId: 'ORG',
    pipelineId,
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })

  const unauth = make('E1')
  await assert.rejects(
    () => unauth.poll(record('1')),
    (error: Error & { httpStatus?: number }) => {
      assert.equal(error.httpStatus, 401)
      assert.equal(isRetryable(error), false)
      return true
    },
  )

  const flaky = make('E2')
  await assert.rejects(
    () => flaky.poll(record('1')),
    (error: Error & { httpStatus?: number }) => {
      assert.equal(error.httpStatus, 500)
      assert.equal(isRetryable(error), true)
      return true
    },
  )

  const down = make('E3', 'http://127.0.0.1:1')
  await assert.rejects(
    () => down.poll(record('1')),
    error => isRetryable(error) === true,
  )

  assert.equal(isRetryable(new Error('plain')), true)
  assert.equal(isRetryable({ retryable: false }), false)
})

it('云效多分支：解析与合并工具函数', () => {
  assert.deepEqual(parseSourceBranches([
    {
      key: 'CI_SOURCE_BRANCHES',
      value: JSON.stringify([
        { CI_COMMIT_REF_NAME: 'a' },
        { CI_COMMIT_REF_NAME: 'b' },
        { CI_COMMIT_REF_NAME: 'a' },
      ]),
    },
  ]), ['a', 'b'])
  assert.deepEqual(parseSourceBranches([]), [])
  assert.deepEqual(parseSourceBranches([{ key: 'X', value: 'nope' }]), [])
  assert.deepEqual(mergeBranches(['a', 'b'], ['b', 'c'], 'append'), ['a', 'b', 'c'])
  assert.deepEqual(mergeBranches(['a'], ['b'], 'replace'), ['b'])
})

it('云效多分支：append 默认合并上次分支 + 本次新增', async () => {
  postBodies = []
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P3',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const run = await provider.trigger({ params: { branches: ['feat-b'] } })
  assert.equal(run.externalId, '43')
  assert.deepEqual(run.branches, ['feat-a', 'feat-shared', 'feat-b'])
  assert.match(String(run.note), /多分支模式（追加）/)
  assert.deepEqual(JSON.parse(postBodies[0].params), {
    branchModeBranchs: ['feat-a', 'feat-shared', 'feat-b'],
  })
})

it('云效多分支：replace 只用本次分支', async () => {
  postBodies = []
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P3',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const run = await provider.trigger({ params: { branches: ['feat-b'], branchMode: 'replace' } })
  assert.deepEqual(run.branches, ['feat-b'])
  assert.deepEqual(JSON.parse(postBodies[0].params), { branchModeBranchs: ['feat-b'] })
})

it('云效多分支：不传 branches 时沿用上次分支集', async () => {
  postBodies = []
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P3',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const run = await provider.trigger({})
  assert.deepEqual(run.branches, ['feat-a', 'feat-shared'])
  assert.deepEqual(JSON.parse(postBodies[0].params), {
    branchModeBranchs: ['feat-a', 'feat-shared'],
  })
})

it('云效多分支：单分支流水线传 branches 直接报错', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P1',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  await assert.rejects(
    () => provider.trigger({ params: { branches: ['x'] } }),
    /不是多分支模式/,
  )
})

it('云效多分支：最近一次没有分支集时回看历史运行', async () => {
  const state = await getYunxiaoBranchState({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P4',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  } as YunxiaoPipeline, process.env)
  assert.equal(state.isBranchMode, true)
  assert.deepEqual(state.previous, ['feat-history'])
})

it('pendingConflict：job result 里的合并冲突提示', () => {
  const run = {
    stages: [{
      stageInfo: {
        jobs: [{ result: '{"message":"合并冲突，请解决后继续，查看 解决冲突","successful":true}' }],
      },
    }],
  }
  assert.match(pendingConflict(run), /合并冲突/)
  assert.equal(pendingConflict({ stages: [] }), '')
})

it('云效：FAIL 但 job result 是「用户已取消」→ canceled', async () => {
  const provider = createProvider({
    type: 'yunxiao',
    baseUrl,
    organizationId: 'ORG',
    pipelineId: 'P6',
    tokenEnv: 'YUNXIAO_TOKEN',
    params: {},
  })
  const out = await provider.poll({
    runId: 'x',
    pipeline: 'P6',
    title: 'P6',
    type: 'yunxiao',
    status: 'running',
    startedAt: new Date().toISOString(),
    externalId: '1',
  })
  assert.equal(out.status, 'canceled')
})
