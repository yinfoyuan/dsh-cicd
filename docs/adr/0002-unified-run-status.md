# ADR-0002: 运行状态统一成五态，平台原值放 rawStatus

- 状态：Accepted
- 日期：2026-10-21

## 背景

五类平台的原始状态对不上：云效 `RUNNING / SUCCESS / FAIL`，GitLab
`created / running / success / failed / canceled`，Jenkins 是 `building + result`，
webhook 完全自定义。如果把这些值直接透给模型，`cicd_wait` 的终态判断、
输出文案、取消逻辑都要按平台分支写。

## 决策

插件内部统一成五个状态：

`running` / `succeeded` / `failed` / `canceled` / `lost`

- 平台原值写入 `record.rawStatus`，状态输出里单独一行展示；
- `lost` 只表示「DSH 重启后丢失 shell 子进程句柄」，不是平台状态；
- 归一化集中在 `providers.ts` 的 `normalizeStatus()`，终态集合在 `state.ts` 的 `TERMINAL`。

## 后果

- 等待/取消/文案只需要认识五态，跨平台逻辑统一。
- 平台新增状态时，最坏情况会落到 `running`（不会误判成失败），排查时看 `rawStatus`。
- 测试可以按五态断言，mock 数据不用覆盖每个平台的完整状态机。
