import type { PipelineConfig, YunxiaoPipeline } from '../src/types.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { ConfigError, extractOrganizationId, extractPipelineId, loadConfig } from '../src/config.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cicd-config-'))
  mkdirSync(join(root, '.dsh'), { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(doc: Record<string, unknown>, name = 'cicd.json') {
  const file = join(root, '.dsh', name)
  writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
  return file
}

/** 这些用例都只配置了一条云效流水线，取出来时按 YunxiaoPipeline 收窄。 */
function yunxiao(config: PipelineConfig): YunxiaoPipeline {
  return config.pipelines.deploy as YunxiaoPipeline
}

it('云效：直接给 pipelineId', () => {
  const file = writeConfig({
    pipelines: {
      deploy: { type: 'yunxiao', organizationId: 'org1', pipelineId: '123456' },
    },
  })
  const config = loadConfig(file, { fresh: true })
  assert.equal(yunxiao(config).pipelineId, '123456')
  assert.equal(yunxiao(config).organizationId, 'org1')
  assert.equal(yunxiao(config).baseUrl, 'https://openapi-rdc.aliyuncs.com')
})

it('云效：粘链接即可，自动取 pipelineId', () => {
  const file = writeConfig({
    pipelines: {
      deploy: {
        type: 'yunxiao',
        url: 'https://devops.aliyun.com/organizations/org9/flow/pipeline/987654',
      },
    },
  })
  const config = loadConfig(file, { fresh: true })
  assert.equal(yunxiao(config).pipelineId, '987654')
})

it('云效：链接里带 organizations 时取 organizationId', () => {
  const file = writeConfig({
    pipelines: {
      deploy: {
        type: 'yunxiao',
        url: 'https://flow.aliyun.com/organizations/org42/pipelines/55555/current',
      },
    },
  })
  const config = loadConfig(file, { fresh: true })
  assert.equal(yunxiao(config).pipelineId, '55555')
  assert.equal(yunxiao(config).organizationId, 'org42')
})

it('云效：中心版缺 organizationId 报清晰错误', () => {
  const file = writeConfig({
    pipelines: {
      deploy: { type: 'yunxiao', pipelineId: '1' },
    },
  })
  assert.throws(() => loadConfig(file, { fresh: true }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /organizationId/)
    assert.match(String(error.hint), /组织/)
    return true
  })
})

it('云效：Region 版自定义 baseUrl 时可省略 organizationId', () => {
  const file = writeConfig({
    pipelines: {
      deploy: { type: 'yunxiao', baseUrl: 'https://region.example.com', pipelineId: '1' },
    },
  })
  assert.equal((loadConfig(file, { fresh: true }).pipelines.deploy as YunxiaoPipeline).organizationId, '')
})

it('env 展开', () => {
  process.env.TEST_PIPELINE_ID = 'env-777'
  const file = writeConfig({
    pipelines: {
      // eslint-disable-next-line no-template-curly-in-string -- 这里就是要测未展开的 ${VAR} 字面量
      deploy: { type: 'yunxiao', organizationId: 'org1', pipelineId: '${TEST_PIPELINE_ID}' },
    },
  })
  const config = loadConfig(file, { fresh: true })
  assert.equal(yunxiao(config).pipelineId, 'env-777')
  delete process.env.TEST_PIPELINE_ID
})

it('缺 pipelineId 报清晰错误', () => {
  const file = writeConfig({ pipelines: { deploy: { type: 'yunxiao', organizationId: 'org1' } } })
  assert.throws(() => loadConfig(file, { fresh: true }), (error) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /pipelineId/)
    return true
  })
})

it('未知 type 报错', () => {
  const file = writeConfig({ pipelines: { x: { type: 'circleci' } } })
  assert.throws(() => loadConfig(file, { fresh: true }), /不认识的 type/)
})

it('解析辅助函数', () => {
  assert.equal(extractPipelineId('https://devops.aliyun.com/flow/pipeline/123'), '123')
  assert.equal(extractPipelineId('123456'), '')
  assert.equal(extractOrganizationId('https://x/organizations/org1/pipelines/2'), 'org1')
})

it('云效：branchMode 只接受 append / replace / off', () => {
  const good = writeConfig({
    pipelines: {
      deploy: { type: 'yunxiao', organizationId: 'org1', pipelineId: '1', branchMode: 'replace' },
    },
  })
  assert.equal((loadConfig(good, { fresh: true }).pipelines.deploy as YunxiaoPipeline).branchMode, 'replace')

  const bad = writeConfig({
    pipelines: {
      deploy: { type: 'yunxiao', organizationId: 'org1', pipelineId: '1', branchMode: 'nope' },
    },
  }, 'bad-branch-mode.json')
  assert.throws(() => loadConfig(bad, { fresh: true }), /branchMode/)
})

it('环境元数据：environment / tier 可选，tier 默认 other', () => {
  const file = writeConfig({
    pipelines: {
      prod: { type: 'yunxiao', organizationId: 'org1', pipelineId: '1', environment: 'production', tier: 'production' },
      uat: { type: 'yunxiao', organizationId: 'org1', pipelineId: '2', environment: 'uat', tier: 'testing' },
      plain: { type: 'yunxiao', organizationId: 'org1', pipelineId: '3' },
    },
  })
  const config = loadConfig(file, { fresh: true })
  assert.equal(config.pipelines.prod.environment, 'production')
  assert.equal(config.pipelines.prod.tier, 'production')
  assert.equal(config.pipelines.uat.environment, 'uat')
  assert.equal(config.pipelines.uat.tier, 'testing')
  assert.equal(config.pipelines.plain.environment, undefined)
  assert.equal(config.pipelines.plain.tier, 'other')
})

it('环境元数据：tier 非法时报错', () => {
  const file = writeConfig({
    pipelines: {
      bad: { type: 'yunxiao', organizationId: 'org1', pipelineId: '1', tier: 'preprod' },
    },
  }, 'bad-tier.json')
  assert.throws(() => loadConfig(file, { fresh: true }), /tier/)
})

it('type 别名：devops / aliyun-devops / alibaba-cloud-devops 都识别为 yunxiao', () => {
  for (const alias of ['devops', 'aliyun-devops', 'alibaba-cloud-devops']) {
    const file = writeConfig({
      pipelines: {
        deploy: { type: alias, organizationId: 'org1', pipelineId: '1' },
      },
    }, `alias-${alias}.json`)
    assert.equal(loadConfig(file, { fresh: true }).pipelines.deploy.type, 'yunxiao', alias)
  }
})
