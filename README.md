# dsh-cicd

[![check](https://github.com/yinfoyuan/dsh-cicd/actions/workflows/check.yml/badge.svg)](https://github.com/yinfoyuan/dsh-cicd/actions/workflows/check.yml)

把项目自己的 **CI/CD 流水线**接进 DeepSeek Harness（DSH）会话：列流水线、触发、跟踪、读日志、取消、查看合并冲突。

本项目是一个**由真实需求驱动、在 DSH 中完成**的项目：从需求澄清、实现、联调到文档，都在 DSH 会话里推进。

当前内置平台适配器：**阿里云云效 Flow**；配置与工具面按多平台设计，后续可接 GitLab / Jenkins 等。

## 能做什么

- 在项目会话里直接问「列一下流水线」「跑一下部署」，不用切到平台页面；
- 触发后**后台跟踪**，阶段变化/结束弹 toast，可选手桌宠气泡；
- 多分支流水线触发时弹窗选分支；
- 失败时直接读日志；合并冲突暂停时可以只读查看冲突文件/分支；
- 设置页统一管理平台 Token、组织、流水线展示名/环境/是否确认。

## 安装

```powershell
# 本地仓库
dsh plugin --profile desktop add link:<本仓库路径>

# 发布到 npm 后
dsh plugin --profile desktop add dsh-cicd
```

装完**重启 DSH**。Web 版把 `desktop` 换成 `web`。

## 5 分钟接入

### 1. 准备云效 Token

云效 → 个人设置 → 个人访问令牌，创建 `pt-` 开头的 token，权限至少包含：

- 流水线运行实例：读写
- 运行任务：只读

推荐在 **设置 → 流水线配置 → 设置 Token** 里粘贴，token 会写入 DSH 凭据存储，保存后不回显。

CI / 无界面场景可用进程环境变量；插件**不再读取**项目里的 `.env` / `.dsh/.env`。

### 2. 用 skill 接入（推荐）

在项目会话里直接把云效流水线链接发出来：

> 把这条云效流水线接进来：https://devops.aliyun.com/organizations/<organizationId>/flow/pipeline/<pipelineId>

或者：

> 帮我把云效流水线 123456 接到这个项目，环境是 test，需要确认

模型会自动加载内置的 `cicd-config` skill，按步骤确认：

- 流水线属于哪个组织；
- 配置里的 key / 展示名；
- 环境（开发/测试/预发/生产）；
- 是否需要 `confirm: true`。

确认后 skill 会写入或更新 `.dsh/cicd.json`，最后用 `cicd_list` 验证。也可以显式调用：

> skill cicd-config

### 3. 手动配置（可选）

如果不想用 skill，在项目根创建 `.dsh/cicd.json`：

```json
{
  "pipelines": {
    "deploy-test": {
      "type": "yunxiao",
      "title": "部署测试环境",
      "organizationId": "5ebbc0228123212b59xxxxx",
      "pipelineId": "123456",
      "environment": "test",
      "confirm": true
    }
  }
}
```

- `organizationId`：从带 `/organizations/<organizationId>/` 的链接里取；中心版必填；
- `pipelineId`：纯数字，例如 `123456`；
- 链接里没有组织时，skill / 手动配置都需要先确认组织。

### 4. 验证

在项目会话里：

> 列一下流水线

或直接调用 `cicd_list`。能看到刚接入的流水线和最近一次运行状态，就接好了。

## 配置字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 固定 `yunxiao`（也接受 `devops` / `flow`） |
| `title` | 是 | 展示名，出现在列表、通知里 |
| `organizationId` | 中心版必填 | 云效组织 ID |
| `pipelineId` | 是 | 云效流水线数字 ID |
| `environment` | 否 | 环境标签：`development` / `test` / `staging` / `production`，界面显示中文 |
| `confirm` | 否 | `true` 时模型必须显式带 `confirm:true` 才能触发；部署类建议开启 |
| `branchMode` | 否 | 多分支默认策略：`append` / `replace` / `off` |
| `runConfig` | 否 | `true` 时每次触发前弹「运行配置」（分支 + 运行变量 + 备注）；变量留空 = 用云效当前值 |
| `params` | 否 | 云效运行参数，按 JSON 对象传入 |

`tokenEnv` 可省略，默认 `YUNXIAO_TOKEN`。token 不会写进 `cicd.json`。

## 日常使用

| 说法 | 实际工具 |
|---|---|
| 列一下流水线 | `cicd_list` |
| 跑 deploy-test | `cicd_run` |
| 现在到哪一步了 | `cicd_status` |
| 看下失败日志 | `cicd_logs` |
| 取消这次运行 | `cicd_cancel` |
| 冲突在哪、哪些文件 | `cicd_conflict`（只读） |
| 这条流水线有哪些运行变量 | `cicd_vars`（只读，不读取值） |

触发类流水线（`confirm: true`）需要用户同意后，模型才会带 `confirm: true` 执行。

触发后**不用**一直等，也不该等：

- `cicd_run` 立即返回 `runId`，**触发完成本轮就结束**；
- 后台跟踪阶段变化和结束，主动弹 toast；
- 模型不要用 `Start-Sleep` / 循环 `cicd_status` 等结果；用户之后要查进度时再用 `cicd_status`（只查一次，不阻塞）；
- 如果用户在触发之外还有后续诉求（结束后继续处理、关注冲突/等待人工确认/异常）：触发时带 `followUp: true`，终态、检测到冲突或等待人工确认时会**自动唤醒模型继续处理**（默认关闭，只发 toast）；
- 用户主动取消后仍会有一条「已取消」toast，但不会再唤醒模型；
- 错过了通知，点会话头部右上角的消息图标看历史。

## 设置页

**设置 → 流水线配置** 管理本地数据，不会修改云效上的流水线：

- **全局配置**：云效 Token（绿点表示已配置）、桌宠/Toast 开关、多宠物时的通知宠物；
- **组织**：添加/重命名/删除；组织 ID 创建后不可改；
- **流水线**：按组织展示云效流水线，可改**显示名称 / 环境 / 是否确认**，或删除；
- 新增流水线先在云效创建，再通过配置文件或 `cicd-config` skill 加入。

## 运行记录

每次运行会在项目里写：

```text
.dsh/cicd-runs/
  <runId>.json   # 运行状态、平台 runId、耗时等；status/cancel/conflict/最近运行会读它
  <runId>.log    # 仅本地 shell 流水线；云效日志实时从平台拉取，不落本地
```

它让 `cicd_status` / `cicd_cancel` / `cicd_conflict` 和设置页“最近运行”在 DSH 重启后仍能找到记录。

这些是本地缓存，**插件不会写或修改任何 `.gitignore`**——要不要忽略由你自己决定。
想让它们不进 git，在项目根或 `.dsh/` 下自己加：

```text
.dsh/cicd-runs/
.dsh/cicd-branches.json
```

`.dsh/cicd.json` 不受影响，仍应正常提交。删除旧记录只影响历史查询，不会影响云效上的流水线。

## 多分支流水线

云效开启分支模式的流水线，`cicd_run` 默认弹窗选分支：

- 默认集合 = 云效上次运行的分支 ∪ 本地保留的分支 − 本地明确移除的分支；
- 勾选 = 保留，取消 = 本次移除；
- 本地记忆在 `<项目>/.dsh/cicd-branches.json`；
- 只有显式传 `branches`，或用户明确要求复用上次运行的分支集合时才跳过弹窗；
- 弹窗不可用会直接报错，不会静默按旧分支触发。

## 运行参数（云效）

触发时可以带云效的运行参数，不用把它们塞进 `params`：

```json
{
  "pipeline": "deploy-test",
  "comment": "发版 1.2.3",
  "envs": { "APP_ENV": "test" },
  "tags": { "https://codeup.aliyun.com/<org>/<repo>.git": "1.2.3" },
  "artifacts": { "pipeline": { "<pipelineId>": "12" } }
}
```

- `comment`：运行备注；`envs`：运行变量；
- `tags` / `repoBranches`：key 是仓库地址，分别指定运行的 tag / 分支（多分支模式的 `branches` 是另一回事）；
- `artifacts`：`pipeline` / `acr` / `packages` 三类制品版本；
- 与 `params` 合并，命名参数优先（整体覆盖，不做深合并）；只支持云效流水线；
- 不确定有哪些运行变量：先调 `cicd_vars { "pipeline": "deploy-test" }`，它只列变量名，**不读取值**；
- `envs` 只覆盖你传的 key，没传的用云效默认值；变量值不会回显，也不会写进运行记录。

## 运行配置弹窗（可选）

在配置里给流水线加 `"runConfig": true`（或设置页勾「触发前弹运行配置」），之后**每次触发前**弹运行配置：

- 多分支流水线：分支选择 + 运行变量 + 运行备注；
- 单分支流水线：运行变量 + 运行备注；
- 变量留空 = 不覆盖，使用云效当前值；只提交填了值的变量；
- 你说「变量 X 为 Y」（例如「TEST_NAME 为 30」）时，模型会用 `envs` 识别并预填到输入框；
- 你话里的运行上下文（版本、环境、目的、变更说明等，例如「预发布版本」）会由模型识别并作为备注预填，可改；清空则不发送；
- 弹窗里输入的值只用于本次触发：不写运行记录、不回显到工具输出；
- 用户明确表示这次不改运行变量时，模型只跳过变量/备注，分支确认仍会弹（除非明确复用上次分支集合）；
- 加密/掩码变量输入框按密码显示，留空则不修改。

## 通知

- 阶段变化：`⏳ [test] 标题 · 阶段…`
- 结束：`✅ 成功` / `❌ 失败` / `⛔ 已取消`
- 合并冲突暂停：提示去云效解决后点「Conflict Resolved」
- 等待人工确认（人工卡点）：`⏸ 等待人工确认：阶段「…」`，处理完再提示继续
- 注意：插件只提醒，不会自动点「通过」；需要人工去云效处理

装了 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 时，同一文案也会投喂到桌宠气泡。
多宠物默认发 `main` / 第一只，可在设置里指定；失败静默，不影响流水线工具。

## token 与安全

- token 只写入 DSH 凭据存储，或用进程环境变量；**不读取项目 `.env` / `.dsh/.env`**；
- 插件只调用配置里声明过的云效流水线；
- `confirm: true` 是部署类流水线的第二道门；
- 不在日志、通知里输出 token。

## 数据流向

插件完全在本机运行，没有中转服务、没有遥测。它碰到的数据只有这几类：

| 数据 | 存在哪 | 会不会离开本机 |
|---|---|---|
| 流水线配置（组织 ID、流水线 ID、展示名、环境、`tokenEnv` 名称） | 项目根 `.dsh/cicd.json` | 否（除非你自己提交进 git） |
| 访问令牌（`pt-…`） | DSH 凭据存储 / `~/.dsh/.credentials.yaml` / 进程环境变量 | 只发给云效 OpenAPI（HTTPS，请求头 `x-yunxiao-token`）；不写进配置、不回显、不进运行记录 |
| 往返的请求 | — | 只发组织 ID、流水线 ID、触发参数、分支列表 |
| 运行状态 / 阶段进度 | 从云效读回，写 `<项目>/.dsh/cicd-runs/*.json` | 平台 → 本机，单向读 |
| 构建日志 | `cicd_logs` 实时从云效拉取，不落盘（本地 `shell` 流水线除外） | **会**：日志尾部作为工具返回进入会话上下文，发给会话所用的模型服务商 |
| 通知（toast / 桌宠） | 本机 `/dsh-cicd/*`、`127.0.0.1` 回环 | 否 |

几点说明：

- **没有统计上报**，插件不向作者或任何第三方发送数据；
- **日志是最需要小心的一环**：`cicd_logs` 只取尾部（默认 120 行 / 20000 字符），但日志里可能有密钥、连接串、个人信息。别在不信任的会话里读生产日志，必要时先在云效侧脱敏；
- token 每次请求时从凭据存储读出，不落到项目目录、不进 `.dsh/cicd-runs/`、不出现在任何工具返回里。

## 排错

| 现象 | 查什么 |
|---|---|
| 没有 `cicd_*` 工具 | 插件装没装、装完有没有重启 DSH |
| `无法确定当前会话的项目目录` | 在有工作目录的项目会话里使用 |
| `找不到流水线配置` | 项目根有没有 `.dsh/cicd.json` |
| 401 / 403 | token 是否过期、权限是否够 |
| 404 | `organizationId` / `pipelineId` 是否对得上 |
| 配置报错 | 错误会指出哪条流水线、哪个字段；JSON 不能有注释 |
| 桌宠没气泡 | 设置里 Token/桌宠开关、dsh-pet 是否安装、宠物是否可见 |

更多参数与行为见 [docs/tools.md](./docs/tools.md)，规格见 [docs/spec/spec.md](./docs/spec/spec.md)。

## 当前限制

- 只支持云效 Flow，其他平台后续按需求再加；
- 本地 `shell` 流水线仅作为内部测试/辅助能力，不在设置页展示；
- 设置页不能新建云效流水线，只能编辑已有流水线的展示元数据；
- 合并冲突只读查看，不会自动合并或恢复运行。

## 发布

版本和 CHANGELOG 由 [release-it](https://github.com/release-it/release-it) 管理，npm 发布由 GitHub Actions 完成：

```powershell
pnpm release:dry
pnpm release patch   # 或 minor / major
```

release-it 会跑 `pnpm check`、生成 CHANGELOG、更新版本、提交并推送 `v*` tag；tag 推送后 Actions 通过 npm **Trusted Publishing（OIDC）** 发布，不需要 `NPM_TOKEN`。

首次发布需要先手动 publish 一次，再在 npm 包设置里配置 Trusted Publisher；完整步骤见 [docs/releasing.md](./docs/releasing.md)。

提交信息使用 [Conventional Commits](./docs/commits.md)，详细步骤见 [docs/releasing.md](./docs/releasing.md)。


## 开发

```powershell
pnpm install
pnpm build
pnpm lint    # ESLint（@antfu/eslint-config）
pnpm test    # vitest run（直接跑 src）
pnpm check   # lint + typecheck + tests + 文档检查
```

工程结构、约定和提交清单见 [AGENTS.md](./AGENTS.md)。

## 免责声明

- 本项目是个人开源项目，**不是阿里云或 DeepSeek 的官方产品**，与二者无隶属、合作或背书关系；
- 「云效」「Yunxiao」「Alibaba Cloud DevOps」等名称是阿里云的商标，此处仅用于**描述所对接的服务**；
- 插件通过公开的云效 OpenAPI 操作**你自己账号有权限的流水线**，触发构建、部署产生的后果由使用者承担；`confirm: true` 只是给模型的一道提示门，不是权限控制；
- 请确认使用方式符合你所在组织的信息安全制度与阿里云服务条款；生产环境建议用专用机器人账号的 token，而不是个人访问令牌；
- 软件按 [MIT 许可](./LICENSE)「按现状」提供，不附带任何明示或暗示的担保。
