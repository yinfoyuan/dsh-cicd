# ADR-0013: 内置 cicd-config skill，用 skill 引导生成配置

- 状态：Accepted
- 日期：2026-10-22

## 背景

流水线配置字段不少（type / pipelineId / organizationId / tokenEnv / branchMode /
environment / tier / confirm），用户手写容易漏字段或把链接当 ID。

DSH 有 skill 能力：`ctx.skills.register()` 可以注册 runtime skill（模型在技能目录里看到，
按需加载正文）。插件安装后即可用，不需要额外分发 SKILL.md 目录。

## 决策

- 新增 `src/skill.ts`，注册 runtime skill `cicd-config`：
  - `source: 'runtime'`；
  - 正文包含：先收集什么、解析链接、配置模板、校验规则、常见错误；
  - 用 `ctx.inject(['skills'], ...)` 等 skills 服务就绪；服务缺失时静默跳过，不影响工具。
- skill 只是**指令**，不改变配置格式、不新增工具；最终校验仍由 `config.ts` 负责。
- 文档（README / spec / 本 ADR）与 skill 正文保持同步。

## 后果

- 用户说「把这条云效流水线接进来：<链接>」时，模型可以加载 skill 并按步骤生成配置。
- skill 内容随代码维护；如果配置字段变化，需要同时改 skill 正文与文档。
- 不依赖 DSH 版本的 skill 目录约定，插件升级也能带着 skill 走。
