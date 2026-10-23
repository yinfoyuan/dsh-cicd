# 环境（测试 / 正式）怎么建模：调研与建议

> 问题：dsh-cicd 要不要像 pm2 那样，加一个字段区分测试 / 正式环境？
> 结论：**要区分，但只做声明式元数据，不做自动判断。**
> 状态：已按本文方案实现（ADR-0011）；当前只展示/编辑 `environment`，`tier` 仅作旧配置兼容保留。

## 一、结论

- 加 `environment`（自由文本，如 `test` / `prod` / `uat` / `gray`）和可选的 `tier`
  （枚举，对齐 GitLab：`development | testing | staging | production | other`）。
- 字段只用于**展示、分组、提示**（`cicd_list` / `cicd_run` / 弹窗徽章），
  **不改变执行语义**；危险流水线仍然靠显式 `confirm: true`。
- 不做「按名字/组织自动猜环境」——猜错生产环境的代价太高，宁可让配置说话。

## 二、别人是怎么区分的

| 工具 | 模型 | 关键点 |
|---|---|---|
| [pm2](https://pm2.io/docs/runtime/best-practices/environment-variables/) | `env` / `env_production` / `env_staging` / `env_test` 配置块 + `--env` 选择 | 环境 = 一套启动参数，选择发生在启动时；没有内置 test/prod 语义 |
| [GitLab CI](https://docs.gitlab.com/ci/environments/) | `environment: name/url`；`deployment_tier` 枚举 `development/testing/staging/production/other`；环境级变量与保护 | 环境是一等对象；tier 可显式指定，名字不匹配时才按正则猜 |
| [GitHub Actions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) | job 上 `environment: <name>`；保护规则、审批、环境 secret | 名字自由；**安全策略挂在环境上**，不是靠名字判断 |
| [Vercel](https://vercel.com/docs/deployments/environments) | production / preview / development 三种上下文；环境变量按上下文生效 | 平台预定义三档，部署时决定 |
| [云效 Flow 多环境发布](https://help.aliyun.com/zh/yunxiao/use-cases/cloud-effect-flow-implements-alibaba-cloud-ecs-multi-environment-release-based-on-the-tag-function) | 环境管理 / 变量组；流水线通常按环境拆开 | 环境在平台侧，流水线本身不强制带 tier |
| [dsh-jenkins](https://github.com/jsoncode/dsh-jenkins) | 项目配置里 `environments` 参数映射 + 显示名；server 下拉切换 | 环境 = 目标 + 参数集，没有 tier 枚举 |
| ci-runner | 无环境概念 | 只按仓库触发 |

共同点：

1. **环境是声明出来的**，不是从名字/分支自动推断（GitLab 有猜测，但允许 `deployment_tier` 覆盖）；
2. **安全策略单独挂在环境上**（GitHub 的保护规则、GitLab 的保护环境、pm2 的启动参数）；
3. **环境名是自由的**，只有「层级/tier」才用固定枚举。

## 三、为什么建议声明式字段

插件无法可靠判断「这条流水线是测试还是生产」：

- 组织 ID、流水线标题、分支都只是线索，不是契约；
- 同一个项目可能有多套云效组织、多种命名习惯；
- 猜错的代价是**误触发生产**——比少一个字段严重得多。

所以：环境信息属于项目配置，插件只负责展示和提示。

## 四、建议的配置形状

```json
"deploy-prod": {
  "type": "yunxiao",
  "title": "示例管理端",
  "environment": "production",
  "tier": "production",
  "tokenEnv": "ALI_YUNXIAO_AK",
  "confirm": true
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `environment` | 否 | 展示名，自由文本（`test` / `uat` / `prod` / `gray`…） |
| `tier` | 否 | 固定枚举，默认 `other`；用于颜色/分组，不参与执行 |

旧配置没有这两个字段 → 按 `tier: "other"` 处理，**行为完全不变**。

## 五、用途（实现范围）

- `cicd_list`：显示 `[production] 示例管理端`，可选按 tier 分组；
- `cicd_run`：输出 `environment` / `tier`，确认提示带环境标签；
- 交互弹窗：标题旁加环境徽章（production 用 warn/error 色，其它用中性色）；
- 文档与示例：说明「生产建议显式 `confirm: true`」。

## 六、明确不做

- 不按名字/组织猜 tier（GitLab 的猜测是平台侧行为，我们保持可预测）；
- 不因为 `tier: production` 自动拦截或自动加 confirm（避免隐藏行为）；
- 不把多环境合并成「一个逻辑流水线 + targets」（那是 dsh-jenkins 的模型，改动大、收益小）。

## 七、待定

- 要不要一个全局开关 `requireConfirmForTiers: ["production"]`（默认关）；
- `cicd_list` 是否默认按环境分组（还是只加标签）；
- 环境是否需要影响通知文案（`⏳ [production] …`）。
