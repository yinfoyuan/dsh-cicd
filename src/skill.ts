/**
 * 内置 skill：教模型把「一条云效流水线」变成项目里的 `.dsh/cicd.json` 配置。
 *
 * 通过 `ctx.skills.register()` 注册成 runtime skill（不依赖 DSH 版本里的 skill 目录约定），
 * 安装插件后模型就能在技能目录里看到 `cicd-config`。
 */
import type { PluginContext } from './types.js'

export const SKILL_NAME = 'cicd-config'

export const SKILL_DESCRIPTION = '生成/修改项目的 .dsh/cicd.json（云效 Flow）'

export const SKILL_WHEN_TO_USE = '用户要接入云效流水线、生成或修改项目流水线配置、或问「流水线怎么配置」时'

/**
 * skill 正文（模型读到的指令）。保持短、可执行，重点是「先收集什么、怎么写、怎么校验」。
 */
export const CICD_CONFIG_SKILL = `# 生成 dsh-cicd 配置

把一条云效（Alibaba Cloud DevOps）流水线接入当前项目：生成或修改 \`.dsh/cicd.json\`。

## 先收集（缺什么问什么）

1. **流水线链接**（推荐）或 \`organizationId\` + \`pipelineId\`。
   链接形如 \`https://devops.aliyun.com/flow/pipeline/123456\`；组织 ID 只在
   \`https://devops.aliyun.com/organizations/<orgId>/...\` 这种链接里。
   **如果链接里没有组织 ID，必须问用户**「这条流水线在哪个云效组织下？」，
   不要照抄模板/其他项目的 \`organizationId\`，也不要猜。
2. **key**：配置里的流水线名（kebab-case，如 \`deploy-test\`），只允许字母/数字/点/下划线/短横线，≤48。
3. **token 环境变量名**（默认 \`YUNXIAO_TOKEN\`），不要索取 token 明文；
   告诉用户在 设置 → 流水线配置 里配置 Token，或用进程环境变量；不要写项目 .env。
4. **environment**：自由文本（test/uat/prod…），只用于展示。
5. **confirm**：生产/部署类必须 \`true\`（模型调用时要显式带 \`confirm: true\`）。

## 步骤

1. 读现有 \`.dsh/cicd.json\`；不存在就创建 \`{ "version": 1, "pipelines": {} }\`，
   **保留其他条目**。
2. 追加/更新一条，模板见下。
3. token 不写进 JSON：让用户在设置页配置 DSH 凭据，或用进程环境变量。
4. 调 \`cicd_list\` 验证：type、environment 标签、最近运行显示正确。
5. **不要**在用户没明确同意时调 \`cicd_run\`（会真实执行）；需要预览时先问。
6. 触发后**本轮就结束**：不要等待、不要 sleep、不要循环 \`cicd_status\`；阶段变化/结束由后台 toast 通知。
   用户之后主动问进度时再用 \`cicd_status\`（只查一次，不阻塞）。
   如果用户的诉求不只是「触发」，而是要在运行结束后继续处理，或关注运行中的合并冲突/异常，
   触发时传 \`followUp: true\`，终态或检测到冲突时会自动唤醒你继续。
7. 多分支流水线**默认一定弹分支选择框**，默认集合 = 云效上次分支 ∪ 本地选中 − 本地移除；
   只有显式 \`branches\`，或用户明确要求复用上次运行的分支集合时才传 \`reusePrevious: true\` 跳过。
   \`interactive:false\` 不再跳过。弹窗不可用会直接报错（不会静默按旧分支跑），不要自己编分支，先告诉用户。

> 本地记录写在 \`<项目根>/.dsh/cicd-runs/\`；插件**不会**写或改任何 \`.gitignore\`，
> 要不要忽略由用户自己加。\`.dsh/cicd.json\` 仍应正常提交。

## 模板

单分支（最常见）：

\`\`\`json
{
  "pipelines": {
    "deploy-test": {
      "type": "yunxiao",
      "title": "部署测试环境",
      "organizationId": "<orgId>",
      "pipelineId": "<pipelineId>",
      "tokenEnv": "YUNXIAO_TOKEN",
      "environment": "test",
      "confirm": true
    }
  }
}
\`\`\`

多分支流水线（云效开启分支模式时）：

\`\`\`json
"branchMode": "append"
\`\`\`

生产环境：

\`\`\`json
"environment": "production",
"confirm": true
\`\`\`

## 校验规则

- \`type\` 只能是 \`shell\` / \`yunxiao\`（别名 \`devops\` / \`flow\` / \`云效\`）。
- \`pipelineId\` 是数字；\`organizationId\` 必须来自用户确认或带组织的链接，不能写死/复制。
  中心版（\`openapi-rdc.aliyuncs.com\`）缺 \`organizationId\` 会直接配置报错；Region 版才可留空。
- \`environment\` 自由文本；不再要求 \`tier\`（旧配置的 tier 仍兼容，但不再展示/编辑）。
- \`branchMode\` ∈ \`append\` / \`replace\` / \`off\`。
- 任何字段都不能出现 token 明文；只写 \`tokenEnv\` 引用。
- 配置改完立即生效（按 mtime 缓存），不用重启 DSH。

## 常见错误

- 把整条链接当 \`pipelineId\`：取 \`flow/pipeline/\` 后面的数字段。
- 忘记 \`confirm: true\`：部署类流水线调用会被拒绝。
- 多分支流水线不写 \`branchMode\`：默认 append（上次运行的分支 + 本次新增）。
- 多分支集成冲突：先调 \`cicd_conflict\` 读冲突文件/分支，和用户确认合并方案；
  解决后由用户去云效点「Conflict Resolved」，插件不会自动合并或恢复运行。
- \`tokenEnv\` 指向不存在的变量：先在设置页配置 DSH 凭据或用进程环境变量，再用 \`cicd_list\` 验证。
- 照抄模板/其他项目的 \`organizationId\`：会连到错误组织（常见 404）；链接没带组织时先问用户。
`

export function registerCicdSkill(ctx: PluginContext): void {
  const skill = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'runtime',
    content: CICD_CONFIG_SKILL,
  }

  const registerInto = (scope: PluginContext): void => {
    const service = (scope.skills ?? scope.get?.('skills', false)) as { register: (skill: unknown) => () => void } | undefined
    if (!service?.register)
      return
    try {
      scope.effect?.(() => service.register(skill))
    }
    catch {}
  }

  // skills 服务可能比插件晚就绪；用 ctx.inject 等它，缺失时降级为直接尝试。
  if (ctx.inject)
    ctx.inject(['skills'], scope => registerInto(scope))
  else registerInto(ctx)
}
