# ADR-0011: 环境用声明式元数据（environment / tier），不自动判断

- 状态：Accepted
- 日期：2026-10-22

## 背景

插件需要让用户和模型一眼看出「这条流水线是测试还是生产」，但插件的 `src/` 里原本没有任何
环境判断；环境信息只隐含在标题（如「示例-部署（测试环境）」）里。

调研（见 [docs/environments.md](../environments.md)）表明主流工具的通行做法：

- pm2 用 `env_test` / `env_production` 配置块 + `--env` 选择；
- GitLab CI 有 `environment` 对象和 `deployment_tier` 枚举（development/testing/staging/production/other），
  允许按名字猜但可用 `deployment_tier` 显式覆盖；
- GitHub Actions 用 `environment: <name>` + 保护规则；
- Vercel 预定义 production / preview / development。

共同点：环境是**声明**出来的；安全策略挂在环境上；环境名自由、只有 tier 用固定枚举。

## 决策

- 流水线配置新增两个可选字段：
  - `environment`：展示名，自由文本（`test` / `uat` / `prod` / `gray`…）；
  - `tier`：`development | testing | staging | production | other`，默认 `other`。
- 两个字段**只影响展示**：
  - `cicd_list` 前缀 `[test · testing]`；
  - `cicd_run` / `cicd_status` 输出 `environment:` 行；
  - 多分支弹窗标题旁显示环境徽章（production 用 warn 色）；
  - 通知/toast 文案前缀 `[environment]`。
- 不参与执行、不自动要求 `confirm`、不按名字/组织猜测；危险流水线仍靠显式 `confirm: true`。
- 旧配置没有字段 → `tier = other`、`environment` 为空，行为完全不变。

## 后果

- 用户可以在不改执行逻辑的前提下给流水线打环境标签；模型在 `cicd_list` 里能直接看到环境。
- 避免了「按名字猜环境」的误判风险（尤其误触发生产）。
- 需要用户手动填字段；没有自动发现云效环境的能力（后续可做只读建议，不影响执行）。
- 未来若要做「生产必须 confirm」，可以基于 `tier` 增加显式开关，而不是隐藏逻辑。
