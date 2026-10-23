import type { PluginContext } from '../src/types.js'
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { CICD_CONFIG_SKILL, registerCicdSkill, SKILL_NAME } from '../src/skill.js'

it('skill 正文覆盖关键步骤与模板', () => {
  assert.match(CICD_CONFIG_SKILL, /先收集/)
  assert.match(CICD_CONFIG_SKILL, /cicd_list/)
  assert.match(CICD_CONFIG_SKILL, /tokenEnv/)
  assert.match(CICD_CONFIG_SKILL, /branchMode/)
  assert.match(CICD_CONFIG_SKILL, /confirm/)
})

it('registerCicdSkill：通过 ctx.inject 等 skills 服务后注册', () => {
  const registered: Array<{ name: string, source: string, description: string }> = []
  const scope = {
    tools: { register() {} },
    skills: {
      register: (skill: unknown) => {
        registered.push(skill as { name: string, source: string, description: string })
        return () => {}
      },
    },
    effect: (fn: () => void) => fn(),
  }
  let injected: string[] | null = null
  const ctx = {
    tools: { register() {} },
    inject: (deps: string[], callback: (scope: PluginContext) => void) => {
      injected = deps
      callback(scope)
    },
  }

  registerCicdSkill(ctx)
  assert.deepEqual(injected, ['skills'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, SKILL_NAME)
  assert.equal(registered[0].source, 'runtime')
  assert.match(registered[0].description, /cicd\.json/)
})

it('registerCicdSkill：没有 skills 服务时静默跳过', () => {
  const ctx = { tools: { register() {} } }
  assert.doesNotThrow(() => registerCicdSkill(ctx))
})
