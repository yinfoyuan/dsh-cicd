# ADR-0012: 当前阶段只保留云效 Flow + shell，其他平台按需求再加

- 状态：Accepted
- 日期：2026-10-22

## 背景

插件最初同时铺了五种类型：shell、云效 Flow、GitLab CI、Jenkins、Webhook。功能还没完成，
多平台会让配置、测试、文档、错误处理都翻倍，真正被用到的只有云效和本地 shell。

用户决定：**当前只保留云效的内容**，其他平台等后续有具体需求再做。

## 决策

- 删除 GitLab / Jenkins / Webhook 的 provider、类型、配置分支、示例与测试；
- `PipelineType` 收窄为 `shell | yunxiao`；未知 type 的报错明确写「目前只支持 shell | yunxiao」；
- 保留 `shell`：它是本地命令/测试/兜底，不是外部平台集成；
- 保留 `yunxiao` 的类型别名：`devops` / `flow` / `aliyun-devops` / `alibaba-cloud-devops`。

## 后果

- 代码、文档、测试更聚焦；`pnpm check` 更快。
- 其他项目里如果还有 `type: "gitlab"` 之类的配置，会得到明确报错（有意的），需要迁移或等后续支持。
- 后续要加回某个平台时，按「类型 → config 分支 → provider → 测试 → 文档」重新补齐，
  并新写一篇 ADR 记录为什么加。
