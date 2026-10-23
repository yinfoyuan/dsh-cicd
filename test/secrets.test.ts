import type { YunxiaoPipeline } from '../src/types.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadEnv, parseCredentials, resolveCredential } from '../src/secrets.js'

let root: string
let dshHome: string
const savedHome = process.env.DSH_HOME

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cicd-secrets-'))
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-cicd-home-'))
  mkdirSync(join(root, '.dsh'), { recursive: true })
  process.env.DSH_HOME = dshHome

  writeFileSync(join(dshHome, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  TEST_CRED: from-credentials',
    '  TEST_OVERRIDE: from-credentials',
    'other:',
    '  TEST_CRED: ignored',
  ].join('\n'), 'utf8')

  writeFileSync(join(root, '.env'), 'TEST_ENV=from-env\nTEST_OVERRIDE=from-env\n', 'utf8')
  writeFileSync(join(root, '.dsh', '.env'), 'TEST_DOTENV=from-dotenv\nTEST_OVERRIDE=from-dotenv\n', 'utf8')
})

afterAll(() => {
  if (savedHome === undefined)
    delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
})

it('credentials 只读 refs 段', () => {
  assert.deepEqual(parseCredentials('refs:\n  A: 1\nother:\n  A: 2\n'), { A: '1' })
})

it('loadEnv 只读 credentials + process.env，忽略项目 .env', () => {
  process.env.TEST_OVERRIDE = 'from-process'
  const env = loadEnv(root)
  assert.equal(env.TEST_CRED, 'from-credentials')
  assert.equal(env.TEST_OVERRIDE, 'from-process')
  assert.equal(env.TEST_ENV, undefined)
  assert.equal(env.TEST_DOTENV, undefined)
  delete process.env.TEST_OVERRIDE
})

// eslint-disable-next-line no-template-curly-in-string -- 测试名要显示字面量 ${VAR}
it('配置里的 ${VAR} 用环境变量展开', () => {
  const configPath = join(root, '.dsh', 'cicd.json')
  writeFileSync(configPath, JSON.stringify({
    pipelines: {
      // eslint-disable-next-line no-template-curly-in-string -- 测未展开的 ${VAR} 字面量
      deploy: { type: 'yunxiao', organizationId: 'org1', pipelineId: '${TEST_CRED}' },
    },
  }), 'utf8')
  const config = loadConfig(configPath, { fresh: true, env: loadEnv(root) })
  assert.equal((config.pipelines.deploy as YunxiaoPipeline).pipelineId, 'from-credentials')
})

it('resolveCredential：DSH credential-ref 优先，解析不到返回 undefined', async () => {
  const ctx = {
    get: (name: string) => (name === 'credentials'
      ? { resolve: async (ref: string) => ({ value: ref === 'ALI_YUNXIAO_AK' ? 'from-dsh' : '' }) }
      : undefined),
  }
  assert.equal(await resolveCredential(ctx, 'ALI_YUNXIAO_AK'), 'from-dsh')
  assert.equal(await resolveCredential(ctx, 'OTHER'), undefined)
  assert.equal(await resolveCredential(undefined, 'ALI_YUNXIAO_AK'), undefined)
})

it('resolveCredential：服务抛错时静默回退', async () => {
  const ctx = {
    get: () => ({
      resolve: async () => {
        throw new Error('boom')
      },
    }),
  }
  assert.equal(await resolveCredential(ctx, 'ALI_YUNXIAO_AK'), undefined)
})
