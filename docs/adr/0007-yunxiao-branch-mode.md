# ADR-0007: 云效多分支模式触发时自动继承上次分支集

- 状态：Accepted
- 日期：2026-10-21

## 背景

云效 Flow 的**多分支模式**流水线（`pipelineConfig.sources[].data.isBranchMode = true`）在运行时不选 release
分支，而是选若干「运行分支」（feature 分支）；release 分支由分支管理器按基础分支自动创建并合并。
网页端「再次运行」会记住上一次集成的分支集，但 OpenAPI 没有这个状态：

- 触发参数是 `branchModeBranchs: string[]`（官方 MCP 里也是这个字段）；
- 运行详情 `globalParams` 里有一条 `CI_SOURCE_BRANCHES`，值是 JSON 数组
  （`[{ "CI_COMMIT_REF_NAME": "feat-x", ... }]`），可以用来还原上次集成的分支；
- 如果调用方只传本次新增的分支，之前的分支就会被排除在 release 分支之外——这不是「再集成」的语义。

## 决策

触发云效流水线时：

1. 先 `GET /pipelines/{id}`，用 `sources[].data.isBranchMode` 判断是否多分支模式；
   配置 `branchMode: "off"` 时跳过检测。
2. 是多分支模式时：
   - `cicd_run` 的 `branches`（或 `params.branches` / `params.branch`）表示本次要新增的运行分支；
   - 默认 **append**：`GET /runs/latestPipelineRun` → 解析 `CI_SOURCE_BRANCHES` → 与本次新增按顺序去重合并，
     作为 `branchModeBranchs` 提交；
   - `branchMode: "replace"`（参数或配置）表示只用本次指定的分支；
   - 合并结果为空时直接报错（提示用 `branches` 指定，或先手动跑一次继承分支集）。
3. 不是多分支模式：
   - 没传分支参数 → 完全按原来的 params 透传（行为不变）；
   - 传了分支参数 → 明确报错（`branches` 只对多分支流水线有意义）。
4. 详情检测失败时：用户显式要求分支 → 报错；没要求 → 退回原样透传，不阻塞普通触发。
5. 触发结果与运行详情都带 `branches` 字段，状态输出显示本次分支集。

## 后果

- 不需要插件自己维护「分支集」状态：云效的运行记录就是事实来源，天然跟网页端一致。
- 每次触发多一次详情 GET（多分支再 +1 次 latest run）；触发是低频操作，可以接受。
- 依赖 `CI_SOURCE_BRANCHES` 全局变量：缺失时视为空集，append 只用本次分支；
  `replace` 可显式清空历史分支集。
- 不改动 `cicd_wait` / 日志 / 取消逻辑；多分支运行和普通运行走同一套跟踪。
