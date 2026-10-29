# 工具参考（给模型/集成方）

所有工具都从**当前会话的项目根**读取 `<项目根>/.dsh/cicd.json`。
项目根 = `exec.agent.session.header.cwd`，所以同一个 DSH 进程里不同项目的会话各看各的配置。

配置改完立即生效（按 mtime 缓存），不需要重启 DSH。

> 平台命名：云效的官方英文名是 **Alibaba Cloud DevOps**（流水线模块叫 **Flow**）；
> 配置 `type` 用短名 `yunxiao`，也接受 `devops` / `aliyun-devops` / `alibaba-cloud-devops`。

## 通用约定

- **流水线名称**：`cicd.json` 里的 key，先用 `cicd_list` 确认。
- **runId**：`cicd_run` 返回，形如 `20261021-162056-deploy-test-a1b2`。
- **状态**：`running` / `succeeded` / `failed` / `canceled` / `lost`；
  平台原始状态在输出的 `rawStatus` 里。
- **确认门禁**：配置了 `confirm: true` 的流水线，`cicd_run` 必须带 `confirm: true`，
  否则抛错并提示先征得用户同意（部署类流水线应始终打开）。
- **token**：`cicd.json` 里只写 `tokenEnv`（变量名），token 本身放 DSH 凭据（设置页）
  或进程环境变量 / `~/.dsh/.credentials.yaml` 的 `refs:`；不读取项目 `.env`。

---

## cicd_list

列出当前项目配置的流水线、类型、说明、最近一次运行。

参数：无。

示例输出：

```
项目：<项目根>
配置：<项目根>\.dsh\cicd.json
流水线：2 条

- deploy-test 🔒 [yunxiao] [test · testing] — 部署测试环境
  最近：✅ succeeded 2026-10-21 16:24:45 (3m36s)
- build [shell]
  最近：还没跑过
```

> `[test · testing]` 是环境元数据（`environment` + `tier`），只影响展示。

## cicd_run

触发一条流水线，**立即返回** `runId`（异步，不阻塞）。触发后插件会自动开始**后台跟踪**：
阶段变化/结束会通过 client toast（或 dsh-pet）提示。**触发完成本轮就结束**：模型直接回复用户，
不要用 `Start-Sleep`、循环 `cicd_status` 等方式等待结果；用户之后主动问进度时再用 `cicd_status`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pipeline` | string | ✅ | 流水线名称 |
| `params` | json | | 传给平台的参数（分支、环境变量等） |
| `comment` | string | | 云效运行备注（显示在运行记录里） |
| `envs` | json | | 云效运行变量，如 `{ "APP_ENV": "test" }`；值支持字符串/数字/布尔。不确定有哪些变量时先用 `cicd_vars` 查 |
| `tags` | json | | 云效按仓库地址指定的运行 tag，如 `{ "https://codeup.aliyun.com/<org>/<repo>.git": "1.0" }` |
| `repoBranches` | json | | 云效按仓库地址指定的运行分支（`runningBranchs`）；多分支模式用 `branches`，不要用它 |
| `artifacts` | json | | 云效制品版本：`{ "pipeline": { "<pipelineId>": "12" }, "acr": { "<registry>/<image>": "<tag>" }, "packages": { "<package>": "<version>" } }` |
| `branches` | json | | 云效多分支模式：本次要新增/替换的运行分支列表 |
| `branchMode` | string | | 多分支处理方式：`append`（默认）或 `replace` |
| `reusePrevious` | boolean | | 当用户明确要复用上次运行的分支集合时传 `true`：跳过弹窗，直接用上次集合 |
| `interactive` | boolean | | 已弃用：默认就是弹窗；`false` 也不会跳过（只有 `reusePrevious:true` 跳过） |
| `runConfig` | boolean | | 触发前是否弹「运行配置」（分支 + 变量 + 备注）：默认按流水线配置 `runConfig`；用户明确表示这次不改运行变量时传 `false` 跳过，需要强制确认时传 `true` |
| `preview` | boolean | | 配合弹窗：只选分支并返回，不触发 |
| `confirm` | boolean | | `confirm: true` 的流水线必须显式传 `true` |
| `followUp` | boolean | | 当用户诉求超出「触发」时传 `true`：结束后继续处理，或关注运行中的冲突/异常；只触发不传 |

当用户在「触发」之外还有后续诉求时（例如运行结束后部署、失败后分析日志、关注合并冲突），
传 `followUp: true`：触发后本轮仍立即结束，运行到终态或首次检测到合并冲突时，插件会用
`agent.followup()` 唤醒模型，发一条带状态/耗时/冲突提示的消息，模型再按上下文继续做
（冲突时用 `cicd_conflict` 读详情）。
不要为了「等结果」传它；不传时只发 toast，用户之后可以再问。

示例：

```json
{ "pipeline": "deploy-test", "params": { "branch": "main" }, "confirm": true }
```

需要跟进运行结果或冲突时：

```json
{ "pipeline": "build", "followUp": true }
```

云效多分支模式示例（把 `feature/login` 加进上次已集成的分支集）：

```json
{ "pipeline": "admin-multibranch", "branches": ["feature/login"], "confirm": true }
```

失败时返回中文原因；`ConfirmRequired` 会提示先向用户确认。

## cicd_vars

只读：列出云效流水线的运行变量（名称/描述/是否加密），**不读取变量值**。
触发前用它确认有哪些变量可覆盖；覆盖用 `cicd_run` 的 `envs`，没传的用平台默认值。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pipeline` | string | ✅ | 流水线名称（先用 `cicd_list` 查看） |

示例输出：

```
流水线「deploy-test」的运行变量（只读，值不会读取）：2 个
- VITE_BASE_URL：前端地址
- NPM_TOKEN（已配置，值不可读）

覆盖某个变量：cicd_run { "pipeline": "...", "envs": { "<key>": "<value>" } }；没传的用平台默认值。
```

- 变量来自云效流水线详情 `pipelineConfig.settings.globalParams[]`；
- `value` 可能是明文密钥，插件**不读取、不回显、不落盘**；
- 加密/掩码变量只显示「已配置，值不可读」；
- shell 流水线没有运行变量，会直接报错。

## cicd_status

查一次运行的状态，**只查一次、不阻塞**；不传 `runId` 时查某条流水线最近一次。

| 参数 | 类型 | 说明 |
|---|---|---|
| `runId` | string | 运行 id |
| `pipeline` | string | 不传 runId 时，按流水线名查最近一次 |

云效会**实时回源**（每次调用打一次平台接口）。不要在 `cicd_run` 之后循环调用它等结果——
运行结束会由后台跟踪通知。

行为：

- 只返回当前 `status/progress/note`，**不等待**；已结束的运行直接返回终态；
- 后台跟踪（`cicd_run` 触发后）：阶段变化推 `⏳`；分支集成**冲突暂停**时推
  `⚠️ 需要手动合并：请在云效解决冲突后点「Conflict Resolved」`；结束推 `✅/❌`；
  失败时若日志里有「合并冲突 / 用户已取消」会在提示里点明；
- 想看历史提示，点会话头部右上角的消息图标。

## cicd_logs

读日志尾部（有行数/字符上限，避免灌爆上下文）。失败先看这里。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `runId` | string | — | 运行 id（必填） |
| `tailLines` | number | 项目配置 `defaults.logTailLines`（120） | 取最后多少行 |
| `maxChars` | number | 20000 | 输出字符上限 |

- shell：直接读本地 `.dsh/cicd-runs/<runId>.log`；
- 云效：优先取失败 job 的日志（最多 4 个），没失败取最后 4 个。

## cicd_conflict

**只读**：读取云效多分支运行的合并冲突信息，供模型和用户一起解决。
不会自动合并，也不会让流水线继续。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | string | ✅ | 运行 id |

返回：

- `conflictFiles`：冲突文件（如 `pnpm-lock.yaml`、`package.json`）；
- `releaseBranch` / `baseBranch` / `featureBranches` / `conflictBranch`；
- `repoUrl`（日志里出现的仓库地址）；
- `paused`：是否 `Merge conflicted, job paused`；
- 日志片段（截断后）。

解决流程：

1. 和用户确认合并方案；
2. 在 release 分支解决冲突并推送；
3. 由用户回云效运行页点「Conflict Resolved」；
4. 恢复后后台跟踪继续通知；插件不会自动点按钮。

## cicd_cancel

取消一次运行：shell 结束整个进程树（Windows 用 `taskkill /t /f`）；
平台类调用平台取消接口（云效是 `PUT .../runs/{runId}`）。

取消后本地状态固定为 `canceled`；**仍会推一条 `⛔ 已取消` 的终态 toast，但不再唤醒模型**
（取消结果已经在工具返回里）。平台侧取消（不是通过本工具）也按普通终态通知；
即使云效事后把 run 标成 `FAIL` 或 job result 写「用户已取消」，也按取消处理。

| 参数 | 类型 | 必填 |
|---|---|---|
| `runId` | string | ✅ |

已经结束的运行直接返回原记录，不会重复取消。

---

## 云效（Alibaba Cloud DevOps）多分支模式

云效 Flow（Alibaba Cloud DevOps 的流水线模块）开启分支模式的流水线
（`pipelineConfig.sources[].data.isBranchMode = true`），运行时需要给
「运行分支」集合，而不是单一代码源分支：

- 默认 **append**：上次运行集成的分支（云效全局变量 `CI_SOURCE_BRANCHES`）+ 本次 `branches`，
  按顺序去重后作为 `branchModeBranchs` 提交；
- `branchMode: "replace"`：只用本次 `branches`；
- 不传 `branches`：多分支流水线会弹窗确认（默认集合含上次分支）；只有 `reusePrevious: true`
  且用户明确要复用上次集合时才直接沿用；
- 非多分支流水线传 `branches` / `branch` 会直接报错（避免看起来成功其实没带分支）；
- 配置里可写 `"branchMode": "append" | "replace" | "off"` 设默认；`off` 表示完全不处理，按原始 params 透传。

触发成功后输出会带 `branches: feat-a、feat-b`，`cicd_status` 也会显示这一行。

### 交互式增减分支

多分支流水线**默认就会弹窗**（不需要 `interactive: true`）：插件会弹出自己的分支选择框（client 组件，挂在
`shell.overlay`，颜色/圆角全部走 DSH 的 `--dsw-*` 变量，明暗主题自动适配）。

- 列表 = 云效上次分支 ∪ 本地选中 − 本地移除，**默认全部勾选**；**勾选 = 保留，取消勾选 = 本次移除**；
- 列表下方输入框 = 新增分支（逗号/空格分隔，可留空）；
- **至少要保留或新增一个分支**，否则「开始运行」不可用；
- 确认后以 `replace` 语义触发，**被移除的分支不会又被 append 加回来**。

```json
{ "pipeline": "admin-multibranch", "confirm": true }
```

当用户明确要复用上次运行的分支集合（不需要重新挑选）时，才用 `reusePrevious` 跳过弹窗：

```json
{ "pipeline": "admin-multibranch", "reusePrevious": true, "confirm": true }
```

先看效果不执行：

```json
{ "pipeline": "admin-multibranch", "interactive": true, "preview": true }
```

> 插件 client 没加载（老版本 DSH / 纯 CLI）时，会回退到通用 `ctx.userQuestions` 提问
> （那个 UI 不支持默认全选，语义反过来：勾选 = 取消）。不是多分支流水线、或没有上次运行记录时也会明确报错。

### 云效运行参数

`comment` / `envs` / `tags` / `repoBranches` / `artifacts` 会映射成云效 `CreatePipelineRun`
的 `params` key，与 `params` 合并、命名参数优先（整体覆盖，不做深合并）：

```json
{
  "pipeline": "deploy-test",
  "comment": "发版 1.2.3",
  "envs": { "APP_ENV": "test", "RETRIES": 2 },
  "tags": { "https://codeup.aliyun.com/<org>/<repo>.git": "1.2.3" },
  "repoBranches": { "https://codeup.aliyun.com/<org>/<repo>.git": "release" },
  "artifacts": {
    "pipeline": { "<pipelineId>": "12" },
    "acr": { "<registry>/<image>": "<tag>" },
    "packages": { "<package>": "<version>" }
  }
}
```

- `tags` / `repoBranches` 的 key 是仓库地址；`branches` 仍然是多分支模式的运行分支集合；
- 值支持字符串/数字/布尔（统一转字符串），嵌套对象/数组会报错；
- 只支持云效流水线，其他类型传这些参数会直接报错。

### 运行配置弹窗（runConfig）

流水线配置 `runConfig: true` 时，每次触发前会弹「运行配置」：

- 多分支流水线：分支选择（默认全选）+ 运行变量 + 运行备注；
- 单分支流水线：运行变量 + 运行备注；
- 变量留空 = 不覆盖，使用云效当前值；只提交非空且属于该流水线变量定义的 key；
- 值只用于本次触发：**不经过模型、不写运行记录、不回显**；
- 用户明确表示这次不改运行变量时，模型可传 `runConfig: false` 跳过弹窗；
- client 不在线时：分支回退到通用提问，变量全部用默认值，输出会提示。

## 进度提示（可选：客户端 toast / dsh-pet）

`cicd_run` 触发后，后台跟踪 `RunWatcher` 会主动提示阶段变化和终态（**不依赖**任何等待工具），
两种提示都是 **best-effort**（失败静默、不阻塞工具）：

1. **插件自带 toast**（推荐，不依赖第三方）：client 半边在右上角弹卡片，6 秒自动消失，点击可关闭；
2. **dsh-pet 气泡**：装了 dsh-pet 时再投喂一份。

| 场景 | 文案 |
|---|---|
| 阶段变化 | `⏳ [test] 示例-部署 · 阶段 2/2 · 部署（运行中）` |
| 成功 | `✅ [test] 示例-部署 执行成功（3m36s）` |
| 失败 | `❌ [test] 示例-部署 执行失败（52s）` |
| 取消 | `⛔ [test] 示例-部署 已取消` |

实现：
- 用户通过 `cicd_cancel` 主动取消时**仍推终态 toast，只是不再唤醒模型**（避免刚取消又被叫醒）；
- toast：`GET /dsh-cicd/notices?since=N` 增量拉取；首次连接只同步序号，不重放历史；
- pet：`POST /dsh-pet-7340/broadcast { text }`，1.5s 超时；
- 关闭桌宠：配置 `pet: false`；toast 不依赖它，仍然保留。
- `followUp: true` 时，终态和首次检测到合并冲突暂停还会用 `agent.followup()` 唤醒模型
  （不是每次阶段变化都唤醒）。

## 运行记录

每次运行在 **`<项目根>/.dsh/cicd-runs/`** 落盘：

```
<runId>.json   # 状态、externalId、耗时、progress、错误等
<runId>.log    # 仅 shell 流水线的完整输出
```

插件**不写也不改任何 `.gitignore`**：要不要忽略这些记录由用户自己决定（例如自己加一行
`.dsh/cicd-runs/`）。`.dsh/cicd.json` 不受影响。

## 典型调用顺序

```
cicd_list                        # 看有哪些
  → cicd_vars { pipeline }       # 需要覆盖运行变量时，先看变量名（不读值）
  → cicd_run { pipeline }        # 触发，拿 runId；本轮到此结束
                                  # 有后续动作时加 followUp:true，终态自动唤醒
  → cicd_status { runId }        # 用户之后主动问进度时查一次
  → cicd_logs { runId }          # 失败时看日志
  → cicd_cancel { runId }        # 需要中止时
```
