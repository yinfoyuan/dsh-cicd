# 云效迭代排期

- 状态：执行中（P0-1 / Y19 / Y20 已完成，下一步 P0-2 运行历史）
- 更新：2026-10-28
- 关联：[spec](./spec/spec.md)、[tools](./tools.md)、[landscape](./landscape.md)

> 范围：只排**云效（Alibaba Cloud DevOps / Flow）**侧的迭代。shell 只作为测试辅助，
> 新平台按 [ADR-0012](./adr/0012-yunxiao-only-scope.md) 等有具体需求再议。
>
> 状态：⬜ 未开始 · 🚧 进行中 · ✅ 已完成。每一项是一个可独立验收的迭代，
> 完成时按 [AGENTS.md](../AGENTS.md) 的演进循环同一提交改代码、测试与文档；
> 涉及写操作（卡点、重试、停止）或改变边界的，先补 ADR。

## 现状（已经闭环，不重复建设）

触发（含多分支 `branchModeBranchs`）、后台跟踪与 toast/followUp、阶段进度、日志尾部、
取消、合并冲突只读解析、设置页本地配置、凭据引用、通知历史。

非目标（见 spec 第 2 节）：流水线编排管理、常驻轮询、公网回调、自动合并冲突。

## P0：v0.3（低风险，只读/参数/文案）

| 编号 | 需求 | 平台接口 | 状态 |
|---|---|---|---|
| Y1 | 运行参数完整覆盖：`comment` / `envs` / `runningTags` / `runningBranchs` / 三类制品 | `CreatePipelineRun` 的 `params` | ✅ |
| Y2 | 云效运行历史（只读 `cicd_runs`） | `ListPipelineRuns` | ⬜ |
| Y3 | 运行信息补全：触发方式/触发人/commit/运行页链接/取消文案 | `GetPipelineRun` 响应字段 | ⬜ |
| Y4 | 错误码翻译 + 设置页「测试连接」 | `GET .../pipelines/{id}` | ⬜ |
| Y5 | 同流水线并发保护（已有 running 时提示/需 force） | `latestPipelineRun` / `ListPipelineRuns` | ⬜ |
| Y19 | 运行变量发现与提示：读流水线变量定义，`cicd_vars` 展示、`cicd_run` 提示模型询问 | `pipelineConfig.settings.globalParams` | ✅（只读副本） |
| Y20 | 运行配置弹窗（`runConfig`）：分支 + 变量 + 备注，空值用默认，值不落盘 | 复用 client overlay + `/dsh-cicd/branch/*` | ✅ |

**Y1 细节**（已按官方文档确认形状，`params` 是 JSON 字符串；工具面已实现
`cicd_run` 的 `comment` / `envs` / `tags` / `repoBranches` / `artifacts`，命名参数优先）：

```json
{
  "branchModeBranchs": ["branch1"],
  "envs": { "k1": "v1" },
  "runningBranchs": { "https://codeup.aliyun.com/<org>/<repo>.git": "master" },
  "runningTags": { "https://codeup.aliyun.com/<org>/<repo>.git": "1.0" },
  "runningPipelineArtifacts": { "<pipelineId>": "12" },
  "runningAcrArtifacts": { "<registry>/<image>": "tag" },
  "runningPackagesArtifacts": { "<package>": "version" },
  "comment": "run note"
}
```

工具面：`cicd_run` 增加 `comment` / `envs` / `tags` / `repoBranches` / `artifacts`，
与 `params` 合并（显式命名参数优先），仍保留 `params` 兜底。

**Y19 细节**（新，2026-10-28 来自真实使用的反馈）：用户在会话里触发流水线时，看不到
云效运行弹窗里的「运行变量」/「运行参数」，也不知道有哪些变量可以填。

- **字段已确认**（2026-10-28 只读探测真实流水线）：`GET .../pipelines/{pipelineId}` 的
  `pipelineConfig.settings.globalParams[]`，每项含 `key` / `description` / `runningConfig` /
  `encrypted` / `masked` / `value`；`runningConfig=true` 即云效运行弹窗里的可配置变量。
- **安全约束**：`value` 是**明文**（含 `NPM_TOKEN`、七牛 AK/SK 这类），实现时只读
  `key/description/runningConfig/encrypted/masked`，**任何工具输出、日志、toast、运行记录都不得带值**；
  `encrypted/masked` 只显示「已配置」。
- 只读提示（先做）：读变量定义后在模型可读处展示变量名，`cicd_run` 触发时提示
  「有 N 个运行变量，没传 `envs` 就用平台默认值」；具体形态待定（新只读工具 `cicd_vars` 或
  `cicd_run` 输出提示）。
- 交互表单（后做，可选）：把多分支弹窗扩展成「运行配置」表单（分支 + 变量 + 备注），
  默认值预填，必填为空时不允许提交；注意变量值不落盘、不回显。

## P1：v0.4（写操作与接入体验，先补 ADR）

| 编号 | 需求 | 平台接口 | 状态 |
|---|---|---|---|
| Y6 | 人工卡点通过/拒绝（`cicd_approve`）+ 卡点状态识别与通知 | `PassPipelineValidate` / `RefusePipelineValidate` | ⬜ |
| Y7 | 单任务重试/跳过/终止 | `RetryPipelineJobRun` / `SkipPipelineJobRun` / `StopPipelineJobRun` | ⬜ |
| Y8 | 设置页从云效导入流水线 | `ListPipelines`（新版路径待确认）+ 详情 | ⬜ |
| Y9 | 构建产物 / 扫描报告链接 | `GetPipelineArtifactUrl` 等 | ⬜ |
| Y10 | 多分支弹窗体验：搜索、过滤「未集成」、最近使用排序 | 无新接口 | ⬜ |

**写操作的安全语义（Y6/Y7 共用）**：必须 `confirm: true` + 用户明确同意；
输出先复述「对哪条运行的哪个阶段/任务做什么」；拒绝类动作同样要确认；
生产环境卡点建议再要一次确认。定稿后写 ADR「运行干预边界」。

## P2：按需（工程与稳定性）

| 编号 | 需求 | 说明 |
|---|---|---|
| Y11 | 429 / `Retry-After` 处理 | 多项目并发轮询会碰限流 |
| Y12 | 跟踪时长与卡点 | 45 分钟上限对「等审批几小时」不够 |
| Y13 | 运行记录清理 | `.dsh/cicd-runs` 无限增长，加保留策略/设置页清理 |
| Y14 | 真实响应契约测试 | 脱敏真实响应做快照，防平台字段改名 |
| Y15 | 配置字段文档化 | `baseUrl` / `triggerPath` / `statusPath` 未进 README 配置表 |
| Y16 | 按组织配置 token | 当前全局单 token，多组织多账号受限 |
| Y17 | 任务级视图与日志分页 | `ListPipelineJobs` / `GetPipelineJobRunLog` |
| Y18 | 主机组 / 主机部署单（评估） | `ListHostGroups` / `GetVMDeployOrder` 等，成本高，先确认需求 |

## 明确不做

- 流水线定义管理（`CreatePipeline` / `UpdatePipeline` / `DeletePipeline`）——spec 非目标；
- 接入官方云效 MCP——ADR-0001 / ADR-0010 的边界，只在 landscape 记录分工；
- 常驻轮询、Webhook 回调——spec 非目标；
- 自动合并冲突、自动点「Conflict Resolved」——保持只读 + 人工；
- 按名字/组织猜环境或 tier；
- 主机部署单完整生命周期（无明确需求前）。

## 待确认（需要真实环境验证）

1. 新版 `/oapi/v1/flow` 各接口的 HTTP 方法与路径：调研只确认了「接口存在 + 用途」，
   除 `CreatePipelineRun` 外按前缀推测，实现前用一次只读调用钉死。
2. 人工卡点暂停在 `GetPipelineRun` 里的表达（status / stage / job 字段），
   决定 `normalizeStatus` 是否需要新增「等待审批」展示态。
3. 运行页面 URL 规则（触发输出里的控制台链接目前硬编码中心版域名）。
4. `CreatePipelineRun` 各参数在真实流水线上的接受情况（文档形状已确认，仍建议一条真实 run 验证）。
5. ~~流水线详情里的运行变量字段~~ **已确认（2026-10-28 只读探测）**：
   `pipelineConfig.settings.globalParams[]`（`key` / `description` / `runningConfig` /
   `encrypted` / `masked` / `value`），`value` 为明文，禁止输出。

## 验收与节奏

- v0.3：P0 全部完成，`pnpm check` 全绿；
- v0.4：先有「运行干预」ADR，再实现 Y6/Y7，Y8 视工作量单独排；
- 每次迭代 = 代码 + 测试 + specs/tools/README 同一提交，行为变化同步 spec 对应章节。
