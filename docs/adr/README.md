# 架构决策记录（ADR）

记录「我们为什么这么做」。编号递增、不修改历史：要推翻旧决策就新写一篇，
把旧的一篇状态改成 `Superseded by ADR-XXXX`。

## 索引

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](./0001-plugin-not-mcp.md) | 做成 DSH 插件而不是 MCP server | Accepted | 2026-10-21 |
| [0002](./0002-unified-run-status.md) | 运行状态统一成五态，平台原值放 rawStatus | Accepted | 2026-10-21 |
| [0003](./0003-polling-wait-strategy.md) | 轮询等待：自适应退避、历史耗时预算、错误分级 | Accepted | 2026-10-21 |
| [0004](./0004-typescript-build.md) | TypeScript + tsc 构建，运行时不引入第三方依赖 | Accepted | 2026-10-21 |
| [0005](./0005-docs-evolve-with-code.md) | Spec/ADR/文档随代码一起演进，并用脚本守门 | Accepted | 2026-10-21 |
| [0006](./0006-pet-progress-notifications.md) | 通过 dsh-pet 的 broadcast 路由做进度提示 | Accepted | 2026-10-21 |
| [0007](./0007-yunxiao-branch-mode.md) | 云效多分支模式触发时自动继承上次分支集 | Accepted | 2026-10-21 |
| [0008](./0008-interactive-branch-selection.md) | 多分支流水线用 ctx.userQuestions 弹窗增减分支 | Accepted | 2026-10-21 |
| [0009](./0009-custom-branch-dialog.md) | 自绘 client 弹窗做分支选择（默认全选 + DSH 主题变量） | Accepted | 2026-10-21 |
| [0010](./0010-credential-ref.md) | token 通过 DSH credential-ref 解析 | Accepted | 2026-10-21 |
| [0011](./0011-environment-metadata.md) | 环境用声明式元数据（environment / tier），不自动判断 | Accepted | 2026-10-22 |
| [0012](./0012-yunxiao-only-scope.md) | 当前阶段只保留云效 Flow + shell，其他平台按需求再加 | Accepted | 2026-10-22 |
| [0013](./0013-config-skill.md) | 内置 cicd-config skill，用 skill 引导生成配置 | Accepted | 2026-10-22 |
| [0014](./0014-background-watch.md) | 触发后后台跟踪，cicd_wait 只做显式阻塞（`cicd_wait` 部分被 0018 取代） | Accepted | 2026-10-22 |
| [0015](./0015-notice-history.md) | 设置页保留最近通知历史（已被 0016 取代） | Superseded by ADR-0016 | 2026-10-22 |
| [0016](./0016-settings-config-center.md) | 设置页改为本地配置中心：全局组织/token + 项目流水线 | Accepted | 2026-10-22 |
| [0017](./0017-vitest.md) | 测试从 node:test 迁到 vitest | Accepted | 2026-10-23 |
| [0018](./0018-remove-cicd-wait.md) | 删除 `cicd_wait`，触发后本轮结束（禁止 sleep/轮询） | Accepted | 2026-10-23 |
| [0019](./0019-followup-wake.md) | 用户要求在触发之外继续跟进时，用 `agent.followup()` 唤醒模型 | Accepted | 2026-10-23 |
| [0020](./0020-no-auto-gitignore.md) | 不自动写入用户的 `.gitignore`，忽略与否由用户决定 | Accepted | 2026-10-23 |

## 模板

新 ADR 请复制下面结构（`scripts/check-docs.mjs` 会校验标题、状态和三个必备章节）：

```markdown
# ADR-NNNN: 一句话标题

- 状态：Proposed | Accepted | Superseded by ADR-XXXX
- 日期：YYYY-MM-DD

## 背景

## 决策

## 后果
```
