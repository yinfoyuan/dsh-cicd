# dsh-cicd 规格说明

- 状态：Draft（功能开发中，尚未发布）
- 维护方式：行为变化必须同步改本文件（见第 10 节）
- 相关：[工具参考](../tools.md)、[ADR 索引](../adr/README.md)、[AGENTS.md](../../AGENTS.md)

## 1. 目标

让 DeepSeek Harness（DSH）会话里的智能体可以**按项目**操作 CI 流水线：
列出项目声明的流水线、触发、查状态、读日志、取消。触发后对话立即空闲，
阶段变化/结果由后台跟踪通知，不需要模型阻塞等待。
同一个 DSH 进程里，不同项目的会话互不干扰；插件全局装一次即可。

## 2. 非目标

- 不做流水线编排/定义管理（流水线在云效 Flow 上建好，这里只操作；本地命令走 shell）。
- 不做多租户、权限系统（沿用平台 token 的权限）。
- 不做常驻轮询：只有触发后的 `RunWatcher` 在 45 分钟内跟踪（可随 DSH 重启丢失）。
- 不提供公网回调接收端（回调见平台侧通知插件）。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 项目根 | 工具执行上下文的 `exec.agent.session.header.cwd` |
| runId | 本插件生成的运行标识（时间戳-流水线名-随机串） |
| externalId | 平台侧的运行 id（云效 runId） |
| 终态 | `succeeded` / `failed` / `canceled` / `lost` 之一 |
| 预算 | 内部 `Runner.wait` 单次调用最多等待的秒数（不通过工具暴露） |

## 4. 角色与场景

| 角色 | 场景 |
|---|---|
| 智能体 | 「部署测试环境」→ 触发 → 本轮结束；用户之后问进度/失败时再查状态、读日志、汇报 |
| 人 | 修改 `.dsh/cicd.json`，下一次工具调用即生效 |

## 5. 功能需求

### 5.1 项目解析与配置

- 从 `exec.agent.session.header.cwd` 解析项目根；缺失时报 `ConfigError`。
- 读取 `<root>/.dsh/cicd.json`（可被插件配置 `configFile` 覆盖）。
- 按文件 mtime 缓存；内容变化后下一次调用重新加载，无需重启。
- 字符串支持 `${ENV_NAME}` 展开，用项目环境变量（见 5.7）。
- 云效中心版（默认 `baseUrl`）必须有 `organizationId`；缺失时配置报错并提示向用户确认，
  不允许从模板/其他项目照抄。
- 校验失败必须给出可照做的中文错误（含 `hint`）。

### 5.2 工具面

| 工具 | 职责 | 是否幂等 |
|---|---|---|
| `cicd_list` | 列出配置的流水线与最近一次运行 | 是 |
| `cicd_run` | 触发，立即返回 runId；`followUp:true` 时终态唤醒模型 | 否（会真实执行） |
| `cicd_status` | 查状态（只查一次）；HTTP 类实时回源 | 是 |
| `cicd_logs` | 读日志尾部（有上限） | 是 |
| `cicd_cancel` | 取消运行 | 否 |

- 标注 `confirm: true` 的流水线，`cicd_run` 必须收到 `confirm: true` 才执行。
- **没有等待/轮询工具**：`cicd_run` 返回后本轮结束，不提供 `cicd_wait`；
  状态查询用 `cicd_status`（每次只查一次，不阻塞）。
- 工具描述用中文，写清「何时用、何时别用」；`cicd_run` 的输出必须明确要求本轮结束，
  禁止 `Start-Sleep` / 循环 `cicd_status`。
- **有后续动作时可以唤醒**：`cicd_run { followUp: true }`（当用户诉求超出「触发」：
  结束后继续处理，或关注运行中的冲突/异常时）会在终态或首次检测到**合并冲突暂停**时通过
  `agent.followup()` 唤醒模型继续；默认 `false`，只发 toast。

### 5.3 运行生命周期与状态

- 插件统一状态：`running` / `succeeded` / `failed` / `canceled` / `lost`。
- 平台原始状态写入 `rawStatus`，不得塞进 `status`。
- `lost` 仅用于「DSH 重启后 shell 子进程句柄丢失」。
- **取消优先**：本地记录一旦是 `canceled`，`status` 不再回源覆盖；云效 run 报 `FAIL`
  但 job `result` 含「用户已取消 / UserCanceled」时也归一为 `canceled`。
- HTTP 类运行在终态时补算 `durationMs`（`finishedAt - startedAt`）。

### 5.4 后台跟踪与通知（核心）

- `cicd_run` 返回后启动 `RunWatcher`：5s 起轮询、逐步退避到 15s、最长 45 分钟；
  阶段变化/终态推 toast，分支冲突暂停时提示手动合并（见 5.14）。
- `cicd_run` 立即返回，触发后本轮就结束；运行进度由后台跟踪通知（见 5.14）。
- **不提供等待工具**：状态查询只有 `cicd_status`（每次只查一次，不阻塞）。
- **followUp 唤醒**（opt-in）：`cicd_run { followUp: true }` 时，`RunWatcher` 在
  终态（`succeeded/failed`；用户主动取消除外）调用 `onTerminal(record, hint)`，并在**首次检测到
  合并冲突暂停**时调用 `onConflict(record)`；`cicd_run` 组装一条 `source.kind = dsh-cicd`
  的 user 消息并调用 `agent.followup()`，把模型唤醒继续用户交代的后续动作（冲突时让模型用
  `cicd_conflict` 读详情、和用户确认解决）。
  - 冲突暂停只唤醒一次；解决后运行继续，到终态会再唤醒一次（用户要求继续处理时）；
  - **用户主动取消不唤醒**：`cicd_cancel` 写入 `canceledByUser`；watcher 仍推 `⛔` 终态 toast，
    但不调用 `onTerminal`（取消结果已经在工具返回里）。平台侧取消仍按普通终态处理；
  - `followup` 不存在（旧 DSH）、agent 已释放或 DSH 重启（watcher 丢失）时静默退化为只发 toast；
  - 唤醒消息只带状态/耗时/冲突/失败提示，并注明「插件自动唤醒，不是用户新发言」；不写死后续业务动作。
- 内部 `Runner.wait`（预算/退避/错误分级）保留用于测试/未来扩展，不通过工具暴露：
  - 预算：显式 `timeoutSec`（5~300s）优先；否则按上次耗时 `×1.25+20s`，夹 60~300s，默认 180s；
  - 第一次查询立即执行；之后 2s→15s 退避（shell 250ms→2s）；
  - 终态立即返回；400/401/403/404 `fatal`，连续 4 次可重试失败 `gave-up`。
- 同一 runId 的并发等待共用一次轮询。
- 等待结果包含 `polls / elapsedMs / budgetSec / budgetSource / lastError`。
- 云效运行显示阶段进度（`阶段 2/2 · 部署（运行中）`）。

### 5.5 日志

- 输出有行数与字符上限（默认 120 行 / 20000 字符，可覆盖）。
- shell 读本地日志文件；云效优先失败 job（最多 4 个）。

### 5.6 取消

- shell：结束整个进程树（Windows `taskkill /t /f`）。
- 平台类：调用平台取消接口（云效 `PUT .../runs/{runId}`）。
- 已终态的运行直接返回原记录。

### 5.7 密钥

- 全局一个云效 token，credential-ref 默认 `YUNXIAO_TOKEN`（设置页写入 `ctx.credentials.set`，只写不读）。
- 每次操作前解析该全局 ref；解析到就注入到流水线的 `tokenEnv` 变量（全局 token 优先）。
- 全局 token 未配置时回退到流水线自己的 `tokenEnv`，再回退本地：
  `~/.dsh/.credentials.yaml` 的 `refs:` → `process.env`。**不读取项目 `.env` / `.dsh/.env`**。
- 任何 API 都不返回 token 值；设置页只显示「已配置 / 未配置」。

### 5.8 运行记录

`<root>/.dsh/cicd-runs/<runId>.json`（+ shell 的 `.log`）。`json` 至少包含
`runId / pipeline / title / type / status / startedAt`，完成后补 `finishedAt / durationMs`。
这些文件是本地运行缓存，**插件不写也不改任何 `.gitignore`**，要不要忽略由用户自己决定；
发布包也不会包含它们。`.dsh/cicd.json` 不受影响，仍应正常提交。

### 5.9 进度提示（可选，dsh-pet）

- 插件配置 `pet`：默认 `true`；设为 `false` 时完全不产生提示。
- 多宠物：优先发给 `petId`（设置页“通知宠物”或插件配置），未配置时 `main`，再退到第一只；
  只发一只，不群发。
- 后台跟踪 `RunWatcher` 在阶段变化/终态投喂气泡（由 `cicd_run` 触发）：
  - 阶段变化：`⏳ <title> · <阶段进度>`；
  - 终态：`✅ 执行成功` / `❌ 执行失败` / `⛔ 已取消` / `❓ 状态丢失`。
- 投喂走 dsh-pet 的公开 HTTP API：`GET /state` 找桌宠（为空时从 `GET /config.pets` 兜底）→
  优先无锁 `POST /broadcast?pet=&surface=any { text, anim:false }`；只有返回 `lock-required`
  （别的插件正在占用）时才 `POST /lock` → 带 `lock=` 投喂 → `POST /lock/release`。
  无锁优先是为了避免取锁/释放触发桌宠自己的工作状态气泡把通知顶掉。
  best-effort：1.5s 超时、失败静默、不阻塞工具返回；404 或网络失败后在本进程内禁用。
- 老版本 dsh-pet 没有 `/lock` 时回退为无锁 `POST /broadcast { text }`。
- dsh-pet 未安装或版本不兼容时不报错、不影响任何工具。

### 5.10 云效（Alibaba Cloud DevOps）多分支模式

- 平台说明：云效的官方英文名是 **Alibaba Cloud DevOps**，流水线模块叫 **Flow**；
  配置 `type` 用短名 `yunxiao`，也接受 `devops` / `aliyun-devops` / `alibaba-cloud-devops`。
- 检测：`pipelineConfig.sources[].data.isBranchMode === true`（配置 `branchMode: "off"` 时跳过）。
- `cicd_run` 的 `branches` 或 `params.branches` / `params.branch` 表示本次要新增的运行分支。
- 默认 **append**：上次运行 `globalParams.CI_SOURCE_BRANCHES` 里的分支 + 本次新增，按顺序去重后
  作为 `branchModeBranchs` 提交；`branchMode: "replace"` 则只用本次。
- 合并不出任何分支时报错，提示用 `branches` 指定或先手动跑一次。
- 非多分支流水线收到分支参数时报错；没收到则行为不变。
- **弹窗默认集合本地记忆**：`<项目>/.dsh/cicd-branches.json` 按流水线保存
  `{ selected, removed }`；下次弹窗 = **云效 `CI_SOURCE_BRANCHES` ∪ selected − removed**。
  这样云效侧别人新加的分支仍会出现，用户明确移除的分支不会复活。
- **自动弹窗失败不静默回退**：没有 UI/分支查询失败时取消触发并返回原因，提示改用 `branches`；
  不再默认按旧分支集直接运行。
- **默认必弹窗**：多分支流水线未显式传 `branches` 时一律弹窗；只有
  `reusePrevious: true`（用户明确要求复用上次运行的分支集合时）才跳过并直接用上次集合。
  `interactive: false` 不再跳过（兼容旧参数）。
- 弹窗优先用插件自绘的 client 弹窗（挂 `shell.overlay`）：
  复选框**默认全选**（勾选 = 保留，取消 = 本次移除），下方输入框新增分支；
  至少保留或新增一个分支；确认后以 `replace` 语义提交最终集合；`preview: true` 只返回选择、不触发。
- client 未加载时回退到 `ctx.userQuestions`（该 UI 不支持默认全选，语义为「勾选 = 取消」）；
  无交互 UI、非多分支或分支查询失败时明确报错，并提示改用 `branches` 参数。
- 触发结果与运行状态都输出 `branches`。

### 5.11 客户端提示（toast）

- 后台跟踪 `RunWatcher`（以及历史落盘）通过 `BranchBroker` 的 notices 队列推 client toast；
- client 每 1s 轮询 `GET /dsh-cicd/notices?since=N`，增量展示，6s 自动消失，点击可关闭；
  首次连接只同步 `seq`，不重放历史。
- 无 client、没有 webServer 或推送失败时静默，不影响工具返回；`pet: false` 只关闭桌宠气泡。

### 5.12 环境元数据（test / prod）

- 流水线只保留 `environment`（自由文本，设置页用下拉：开发/测试/预发/生产，分别存
  `development/test/staging/production`；旧的自定义值也保留展示）。旧配置里的 `tier`
  （`development | testing | staging | production | other`）仍可解析，但不再展示或编辑；
  `environment` 为空时展示回退到旧的 `tier`。
- 只用于展示：`cicd_list` 前缀 `[test]`；`cicd_run` / `cicd_status`
  输出 `environment:` 行；多分支弹窗标题旁徽章；toast 文案前缀 `[environment]`。
- 不参与执行、不自动要求 confirm、不按名字/组织猜测；危险流水线仍靠显式 `confirm: true`。
- 旧配置无 `environment` 且无 `tier` 时不展示环境标签，行为不变。

### 5.13 配置生成 skill

- 插件注册 runtime skill `cicd-config`（`ctx.skills.register`，`source: runtime`）：
  正文包含先收集什么、链接解析、配置模板、校验规则与常见错误。
- 通过 `ctx.inject(['skills'], ...)` 等 skills 服务就绪；服务缺失时静默跳过，不影响工具。
- skill 只提供指令，不改变配置格式；最终校验仍由 `config.ts` 负责。

### 5.14 后台跟踪与主动提示

- `cicd_run` 返回后立即启动 `RunWatcher`（5s 起，逐步退避到 15s；最长跟踪 45 分钟）：
  - 阶段进度变化 → toast/桌宠 `⏳ [env] 标题 · 阶段…`；
  - 终态 → `✅/❌/⛔` 提示；失败时读日志尾部，识别「合并冲突 / 用户已取消」并附在提示里。
  - 用户通过 `cicd_cancel` 主动取消时仍推终态 toast，但不再唤醒模型（取消结果已在工具返回里）。
- 同一 `runId` 只跟踪一次；DSH 重启后跟踪器丢失（运行记录仍在，可用 `cicd_status` 查）。
- **分支集成冲突**：云效把「合并冲突，请解决后继续」写在 job `result` 里，`poll` 会转成
  `record.note`；watcher 检测到 note（或日志里的 `Merge conflicted, job paused`）时推一条
  `⚠️ 检测到合并冲突，运行在等你手动处理：请在云效解决冲突后点「Conflict Resolved」`（每次运行只推一次）。
- **没有等待工具**：`cicd_run` 的输出明确要求「本轮到此结束」，禁止 `Start-Sleep`、
  循环 `cicd_status` 或任何轮询；结果由后台 toast 通知，用户之后主动问进度时再用 `cicd_status`。
- **followUp 唤醒**：`followUp: true` 时终态（用户主动取消除外）会调用 `agent.followup()`，
  首次检测到合并冲突暂停也会调用一次；分别用 `followUpText()` / `conflictWakeText()` 生成
  「状态/冲突 + runId + 失败提示 + 不是用户新发言」的消息。其他情况只 toast。
- 多分支流水线**默认必弹窗**：未传 `branches` 且是云效多分支时自动弹；弹窗不可用时**取消触发并报错**
  （不静默按旧分支跑）；只有显式 `branches` 或 `reusePrevious: true`（用户明确要求复用上次集合）跳过弹窗。

### 5.15 通知历史（头部快捷入口）

- `BranchBroker` 按 `historyLimit` 保留 notice（`seq / text / level / at / project / runId`），
  **落盘**到 `$DSH_HOME/cicd-notices.json`；历史是全局的（所有项目共用）。
- `GET /dsh-cicd/notices/history?limit=50` 返回最新在前；`POST /dsh-cicd/notices/clear` 清空并落盘；
- client 注册 `conversation.session.header.utilities` 快捷入口（消息图标）：点击弹出最近通知 popover，
  打开期间每 2s 刷新，支持清空；点击外部/Esc 关闭；未读时显示小圆点，打开即标记已读。
- **去重按运行**：同一次运行（`project + runId + text`）连续相同的文本只保留最新一条（`count` 累计次数）；
  不同运行即使文本一样也分开保留；popover 按同样键再合并一次并显示 `×N`；
  toast 栈里同文本只保留一条（刷新计时）。
- 文件缺失/损坏按空历史处理；DSH 重启后历史仍在。
- **设置页不再展示通知列表**（见 5.17）。

### 5.16 冲突信息读取（cicd_conflict）

- 只读工具：从云效「分支 / Git / merge」相关 job 日志里提取冲突文件、release/base/feature 分支、
  仓库地址、`job paused` 标记和日志尾部（`src/conflict.ts` 解析）。
- **不自动合并、不自动恢复运行**；流程是：和用户确认方案 → 在 release 分支解决并推送 →
  用户回云效点「Conflict Resolved」→ 后台跟踪继续通知。
- 优先抓分支相关 job，避免普通 `cicd_logs` 只取最后 4 个 job 时丢掉冲突信息。

### 5.17 设置页「流水线配置」

- 设置页只做本地配置，不展示通知列表、不修改云效远端；通知列表在头部 popover（5.15）。
- 结构：全局配置（token 状态、pet/toast）→ 组织（名称/ID/baseUrl）→ 组织下的流水线卡片（编辑/删除）。
- 组织支持添加/重命名/删除；**Organization ID 创建后不可修改**；删除时若仍被流水线引用会拒绝。
  已有组织没有名称时显示 ID。
- 流水线列表只展示云效流水线；`shell`（本地命令）暂不在设置页展示，只作为测试辅助。
- 项目来源：`$DSH_HOME/cicd-projects.json`，`resolveProject` 时记录；组织元数据在
  `$DSH_HOME/cicd-settings.json` 的 `organizations`；偏好与全局 token ref 也在该文件。
- 全局一个 token：设置页输入 → `ctx.credentials.set(YUNXIAO_TOKEN, value)`，只写不读；不展示 tokenEnv。
- 编辑流水线只允许改**显示名称 / 环境 / confirm**，写回对应项目的 `.dsh/cicd.json`
  （原子写 + 用 `config.ts` 重新校验）；不提供“添加流水线”表单，新增先在云效创建，再由配置/skill 加入；
  删除流水线和新增/删除组织都只动本地数据。
- API（同一 webServer，`/dsh-cicd/config`）：`GET /` 快照、`GET /prefs`、
  `PUT|DELETE /pipeline`、`PUT|DELETE /organization`、`POST|DELETE /token`、`PUT /prefs`。

### 5.18 云效运行参数（触发）

- `cicd_run` 除 `params` 透传外，提供云效一等运行参数（对应 `CreatePipelineRun` 的
  `params` JSON 字符串，形状以官方文档为准）：

  | 工具参数 | 平台 key | 说明 |
  |---|---|---|
  | `comment` | `comment` | 运行备注 |
  | `envs` | `envs` | 运行变量（对象，值统一转字符串） |
  | `tags` | `runningTags` | 按仓库地址指定 tag |
  | `repoBranches` | `runningBranchs` | 按仓库地址指定运行分支（多分支模式的 `branches` 不是它） |
  | `artifacts.pipeline` / `.acr` / `.packages` | `runningPipelineArtifacts` / `runningAcrArtifacts` / `runningPackagesArtifacts` | 流水线 / ACR / 制品包版本 |

- 合并顺序：`pipeline.params`（配置默认）→ `params` → 命名参数；命名参数**整体覆盖**同名 key，
  不做深合并。
- `branches` / `branchMode` 仍走 5.10 的多分支逻辑，与上述参数互不影响。
- 只支持云效流水线；其他类型传这些参数时报错。值必须能转成字符串（数字/布尔自动转），
  嵌套对象/数组报错。

### 5.19 云效运行变量（只读副本 + 覆盖写入）

- `cicd_vars { pipeline }` 只读：从云效流水线详情 `pipelineConfig.settings.globalParams[]`
  取变量定义，输出 `key` / `description` / `runningConfig` / `encrypted` / `masked`。
- **变量值永不读取**：平台返回的 `value` 可能是明文密钥，适配器不映射、不输出、不落盘；
  工具输出、日志、toast、运行记录里都不能出现值。加密/掩码变量只显示「已配置」。
- 触发时把变量定义的副本写入 `RunRecord.variables`（仅元数据），`cicd_run` 输出
  `运行变量：N 个（未覆盖，使用平台默认值）`；显式传 `envs` 的 key 覆盖，未传的用平台默认值。
- `envs` 只做覆盖写入，不修改云效流水线定义；`cicd.json` 的 `params.envs` 可作固定默认覆盖。
- shell 流水线没有运行变量；`cicd_vars` 报错并提示只有云效有。
- 读取失败时错误信息只带状态码/通用原因，**不带响应体**（避免把明文值带进工具输出）。
- 触发时 `envs` 的值只在内存里传给平台；运行记录不写值，只写 `overriddenVariables` 变量名。

### 5.20 运行配置弹窗（runConfig）

- 流水线配置 `runConfig: true` 时，每次 `cicd_run` 触发前弹「运行配置」：
  多分支流水线含分支选择，另有运行变量与运行备注。
- 弹窗由 client 的 `shell.overlay` 提供（复用分支弹窗通道 `/dsh-cicd/branch/*`）；
  输入的值只用于本次触发：**不经过模型、不写运行记录/日志/通知、不回显**。
- 变量输入留空 = 不覆盖，使用云效当前值；只提交非空且属于该流水线变量定义的 key。
- 运行备注可由模型从用户话里提取（例如「预发布版本」）并通过 `comment` 传入，弹窗预填；
  用户清空则本次不发送备注。
- 触发后 `RunRecord.overriddenVariables` 只记录被覆盖的变量名。
- 模型可按用户意图用 `cicd_run.runConfig` 覆盖配置：`true` 强制弹；`false` 只跳过变量/备注，
  分支确认仍会弹（除非 `reusePrevious`）；不传则按流水线配置。
- 开启 runConfig 的流水线：显式 `branches` 只作为弹窗预选，不再跳过确认；
  只有 `reusePrevious: true` 才是无弹窗路径。
- client 不在线时：多分支回退到 `ctx.userQuestions` 选分支；变量不弹，全部用平台默认值，
  并在输出里提示「运行配置弹窗不可用」。
- `preview: true` 只返回分支与变量名（不返回值），不触发。

## 6. 数据模型

`RunRecord`（完整字段见 `src/types.ts`）：

| 字段 | 说明 |
|---|---|
| `runId` | 插件生成 |
| `pipeline` | 配置里的名称 |
| `type` | shell / yunxiao（云效，别名 devops / flow） |
| `status` | 五态 |
| `startedAt` / `finishedAt` / `durationMs` | 时间 |
| `params` | 触发参数 |
| `externalId` / `url` | 平台标识与页面 |
| `rawStatus` | 平台原始状态 |
| `progress` | 云效阶段进度 |
| `branches` | 云效多分支模式：本次集成的分支列表 |
| `variables` | 云效运行变量副本（仅 key/描述/标记，不含值） |
| `overriddenVariables` | 本次显式覆盖的运行变量名（只有 key，值不落盘） |
| `canceledByUser` | 通过 `cicd_cancel` 取消：仍推终态 toast，但不再唤醒模型 |
| `checkError` / `checkErrorRetryable` | 最近一次查询错误及是否可重试 |
| `exitCode` | shell 退出码 |

`WaitMeta`：`polls / elapsedMs / timedOut / abortReason / errorStreak /
budgetSec / budgetSource / lastDurationMs / lastError`。

## 7. 错误模型

| 错误 | 场景 | 表现 |
|---|---|---|
| `ConfigError` | 配置缺失/非法 | 中文错误 + `hint` |
| `PipelineError` | 运行/查询失败 | 中文错误 + `hint` |
| `ConfirmRequired` | 需要确认的流水线未确认 | 提示先征得用户同意 |
| HTTP 错误 | 平台接口失败 | 带 `httpStatus`、`retryable` |

查询类错误可重试；触发类错误**不自动重试**（避免重复执行）。

## 8. 非功能需求

- **安全**：token 不进 `cicd.json`、不进日志、不进 git。
- **性能**：一次 4 分钟构建的轮询请求 ≤ 20 次（退避后）。
- **可观测**：每次运行有 json 记录；内部 `Runner.wait` 有轮询统计（不暴露给模型）。
- **兼容**：Node `^22.19.0 || >=24`；运行时只依赖 DSH 注入的
  `@deepseek-ai/dsh-tools` 与 Node 内置模块。
- **可维护**：strict TypeScript；`pnpm check` 包含类型、测试、文档一致性。
- **可选集成**：dsh-pet 缺失或不可用时，核心功能与输出不变。

## 9. 验收标准

1. `pnpm check` 全绿（typecheck + 全部测试 + 文档检查）。
2. 配置错误能给出可直接照做的提示。
3. 触发→后台通知→成功/失败→日志链路在云效测试环境可复现。
4. 4 分钟构建期间对话不被阻塞；`cicd_run` 立即返回，且输出明确要求本轮结束、禁止 sleep/轮询。
5. 401 场景首次查询即停止（`fatal`）；不可达接口 ≤ 4 次后停止（`gave-up`）。
6. `docs/tools.md` 的工具章节与代码注册的工具完全一致（脚本校验）。
7. 装 dsh-pet 时，后台跟踪到终态/冲突会投喂气泡；未装时所有工具行为不变。
8. 多分支流水线：append 模式提交的分支 = 上次运行分支 ∪ 本次新增；replace 模式只提交本次分支。
9. 当用户诉求超出「触发」（结束后继续处理，或关注冲突/异常）时，`followUp: true` 在终态和
   首次冲突暂停时唤醒模型；默认 `false` 不唤醒，只发 toast。
10. 用户通过 `cicd_cancel` 取消后：仍有一条终态 toast，但不会唤醒模型；平台侧取消仍通知。

## 10. 变更管理

- 行为变化 → 更新本文件对应章节；
- 架构选择 → 新增 `docs/adr/NNNN-*.md` 并更新索引；
- 工具面变化 → 更新 `docs/tools.md`（脚本会校验）；
- 用户可见变化 → 更新 `README.md`；
- `pnpm check` 会跑 `scripts/check-docs.mjs`，文档漂移直接失败。

**文档和代码同一个提交**——这条对人和模型同样适用。
