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
阶段变化/结束会通过 client toast（或 dsh-pet）提示，用户可以继续对话，**不需要**立刻 `cicd_wait`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pipeline` | string | ✅ | 流水线名称 |
| `params` | json | | 传给平台的参数（分支、环境变量等） |
| `branches` | json | | 云效多分支模式：本次要新增/替换的运行分支列表 |
| `branchMode` | string | | 多分支处理方式：`append`（默认）或 `replace` |
| `reusePrevious` | boolean | | 仅当用户明确说「沿用上次分支」时传 `true`：跳过弹窗，直接用上次集合 |
| `interactive` | boolean | | 已弃用：默认就是弹窗；`false` 也不会跳过（只有 `reusePrevious:true` 跳过） |
| `preview` | boolean | | 配合弹窗：只选分支并返回，不触发 |
| `confirm` | boolean | | `confirm: true` 的流水线必须显式传 `true` |

示例：

```json
{ "pipeline": "deploy-test", "params": { "branch": "main" }, "confirm": true }
```

云效多分支模式示例（把 `feature/login` 加进上次已集成的分支集）：

```json
{ "pipeline": "admin-multibranch", "branches": ["feature/login"], "confirm": true }
```

失败时返回中文原因；`ConfirmRequired` 会提示先向用户确认。

## cicd_status

查一次运行的状态；不传 `runId` 时查某条流水线最近一次。

| 参数 | 类型 | 说明 |
|---|---|---|
| `runId` | string | 运行 id |
| `pipeline` | string | 不传 runId 时，按流水线名查最近一次 |

云效会**实时回源**（每次调用打一次平台接口）。

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

## cicd_wait

查看一次运行状态。**只查一次，不阻塞、不等待**；运行结束由后台跟踪通知。
不要用它跟踪运行，也不要在 `cicd_run` 之后自动调用。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | string | ✅ | 运行 id |

行为：

- 返回 `status/progress/note` + 提示，不占用对话；
- 已结束的运行直接返回终态；
- **后台跟踪**（`cicd_run` 触发后）：阶段变化推 `⏳`；分支集成**冲突暂停**时推
  `⚠️ 需要手动合并：请在云效解决冲突后点「Conflict Resolved」`；结束推 `✅/❌`；
  失败时若日志里有「合并冲突 / 用户已取消」会在提示里点明；
- 想主动查进度用 `cicd_status`；想看历史提示打开「设置 → 流水线通知」。

示例输出：

```
✅ deploy-test · succeeded
progress:  阶段 2/2 · 部署（成功）

这次运行已经结束。
本工具只查一次状态，不会等待。
```

## cicd_cancel

取消一次运行：shell 结束整个进程树（Windows 用 `taskkill /t /f`）；
平台类调用平台取消接口（云效是 `PUT .../runs/{runId}`）。

取消后本地状态固定为 `canceled`；后台跟踪会推 `⛔ … 已取消`（即使云效事后把 run 标成 `FAIL`
或 job result 写「用户已取消」，也按取消处理）。

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
- 不传 `branches`：沿用上次的分支集，相当于网页端「再次运行」；
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

只有用户**明确说「沿用上次分支」**时才跳过弹窗：

```json
{ "pipeline": "admin-multibranch", "reusePrevious": true, "confirm": true }
```

先看效果不执行：

```json
{ "pipeline": "admin-multibranch", "interactive": true, "preview": true }
```

> 插件 client 没加载（老版本 DSH / 纯 CLI）时，会回退到通用 `ctx.userQuestions` 提问
> （那个 UI 不支持默认全选，语义反过来：勾选 = 取消）。不是多分支流水线、或没有上次运行记录时也会明确报错。

## 进度提示（可选：客户端 toast / dsh-pet）

`cicd_wait` 结束/超时后，插件会尝试两种提示，都是 **best-effort**（失败静默、不阻塞工具）：

1. **插件自带 toast**（推荐，不依赖第三方）：client 半边在右上角弹卡片，6 秒自动消失，点击可关闭；
2. **dsh-pet 气泡**：装了 dsh-pet 时再投喂一份。

| 场景 | 文案 |
|---|---|
| 等待超时 / 仍在运行 | `⏳ 示例-部署 还在执行（已等 3m12s） · 阶段 2/2 · 部署（运行中）` |
| 成功 | `✅ 示例-部署 执行成功（3m36s）` |
| 失败 | `❌ 示例-部署 执行失败（52s）` |
| 取消 | `⛔ 示例-部署 已取消` |

实现：
- toast：`GET /dsh-cicd/notices?since=N` 增量拉取；首次连接只同步序号，不重放历史；
- pet：`POST /dsh-pet-7340/broadcast { text }`，1.5s 超时；
- 关闭桌宠：配置 `pet: false`；toast 不依赖它，仍然保留。

## 运行记录

每次运行在 **`<项目根>/.dsh/cicd-runs/`** 落盘：

```
<runId>.json   # 状态、externalId、耗时、progress、错误等
<runId>.log    # 仅 shell 流水线的完整输出
```

建议把 `.dsh/cicd-runs/` 加进项目 `.gitignore`。

## 典型调用顺序

```
cicd_list                        # 看有哪些
  → cicd_run { pipeline }        # 触发，拿 runId
  → cicd_wait { runId }          # 等结束（可重复调用）
  → cicd_logs { runId }          # 失败时看日志
  → cicd_cancel { runId }        # 需要中止时
```
