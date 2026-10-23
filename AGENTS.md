# AGENTS.md — 在本仓库工作的智能体说明

> 这是给「在本仓库里改代码的智能体」看的工程说明；面向插件使用者的文档在
> [README.md](./README.md)，工具参考在 [docs/tools.md](./docs/tools.md)。

## 项目是什么

`dsh-cicd` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：
把「每个项目自己的 CI 流水线」注册成一组 `cicd_*` 工具，让会话里的智能体可以
列流水线、触发、查状态、读日志、取消；触发后本轮结束，由后台跟踪通知进度。

- **插件全局装一次**：`dsh plugin --profile desktop add link:<本仓库路径>`；
- **配置按项目隔离**：每个项目根 `.dsh/cicd.json`，改完即时生效（按 mtime 缓存）；
- **token 与配置分离**：`.dsh/cicd.json` 只写 `tokenEnv` 引用；`tokenEnv` 同时是
  DSH credential-ref（`ctx.credentials.resolve`），服务不可用时回退到
  进程环境变量 / `~/.dsh/.credentials.yaml` 的 `refs:`；**不读取项目 `.env`**。

支持的类型（当前阶段）：`shell`（本地命令）、`yunxiao`（云效 / **Alibaba Cloud DevOps**，流水线模块 Flow；
别名 `devops` / `aliyun-devops` / `alibaba-cloud-devops`）。GitLab / Jenkins / Webhook 等**后续有需求再加**。

## 仓库地图

```
src/
  index.ts     插件入口：name / inject / apply（注册工具）
  tool-defs.ts 六个工具的声明与执行体（不 import dsh-tools，方便测试）
  project.ts   从 exec.agent.session.header.cwd 解析项目根
  config.ts    cicd.json 读取 / 校验 / ${ENV} 展开
  secrets.ts   token 解析（DSH credential-ref 优先，本地 env 回退）
  runner.ts    触发、状态、日志、取消、轮询等待（Runner 类）
  providers.ts 云效 Flow 适配器 + 阶段进度解析 + 错误分级
  conflict.ts  合并冲突日志解析（cicd_conflict 只读工具）
  settings-store.ts 全局设置/组织/已知项目存储（$DSH_HOME）
  config-service.ts 设置页配置 API（读/写 .dsh/cicd.json、token、prefs）
  state.ts     运行记录 json/log 的落盘与读取
  format.ts    给模型看的文本（清单、运行详情）
  types.ts     共享类型（配置、RunRecord、Provider、WaitMeta…）
  pet.ts       可选：把后台进度投喂给 dsh-pet 气泡（best-effort）
  prompt.ts    通用 userQuestions 回退（勾选 = 取消）
  branch-broker.ts  自定义弹窗的 host 侧 HTTP 通道（/dsh-cicd/branch/*）
  client/index.tsx  浏览器半边：分支弹窗、toast、设置页「流水线配置」、头部通知入口
  skill.ts     内置 `cicd-config` runtime skill（教模型生成配置）
  watcher.ts   触发后的后台跟踪（阶段/结束 toast，冲突提示）
test/          vitest 测试（直接 import src/*.ts，由 vitest 转译）+ `test/tsconfig.json`
                （就近配置：编辑器与 CLI 用同一份，测试同样按 strict 检查）
vitest.config.ts  测试配置（include / node 环境 / 超时）
docs/
  spec/spec.md 需求/数据模型/验收标准 —— 当前行为的唯一事实来源
  adr/         架构决策记录（为什么这么做）
  tools.md     工具参考（模型直接读）
  landscape.md 竞品与生态调研
  environments.md 测试/正式环境建模调研
scripts/check-docs.mjs  文档一致性检查（pnpm check 会跑）
scripts/build-client.mjs esbuild 打包 lib/client.js（__ModuleLoader__ 协议）
examples/      cicd.json 示例
```

## 常用命令

```powershell
pnpm install
pnpm build        # tsc（host）+ esbuild（lib/client.js）
pnpm typecheck    # host / client / test 三套 tsconfig 都检查
pnpm lint         # ESLint（@antfu/eslint-config）；pnpm lint:fix 自动修
pnpm test         # vitest run（直接跑 src，不需要先 build）
pnpm check        # lint + typecheck + build + test + 文档检查（node scripts/check-docs.mjs）
```

改完源码后**必须** `pnpm check`。测试直接 import `src/*.ts`（`.js` 说明符由 vitest 解析到 `.ts`），
产物层由 `check` 里的 `build` 覆盖。

## 不可破坏的约定

1. **状态只有 5 个值**：`running / succeeded / failed / canceled / lost`。
   平台原始状态放 `record.rawStatus`，不要往 `status` 里塞新值。
2. **触发后不等待**：`cicd_run` 立即返回、本轮结束；没有 `cicd_wait` 工具，
   状态查询用 `cicd_status`（只查一次，不阻塞）。不要重新引入等待/轮询模式，
   也不要在工具输出里建议 `Start-Sleep` 或循环查询（内部 `Runner.wait` 仅供测试/未来）。
   当用户诉求超出「触发」（结束后继续处理，或关注运行中的冲突/异常）时用 `followUp: true` +
   `agent.followup()`（终态 + 首次冲突暂停各唤醒一次），不要用阻塞/轮询实现这个需求。
   用户通过 `cicd_cancel` 主动取消时（记录带 `canceledByUser`）**保留终态 toast，但不再唤醒模型**，
   避免「刚取消又被叫醒」；平台侧取消仍按普通终态处理。
   改这块时同步更新 README 与 docs/tools.md。
3. **token 永远不进 `cicd.json`**；新增平台时沿用 `tokenEnv` 引用。
4. **工具描述用中文**（和现有风格一致），面向模型，写清楚「什么时候用、什么时候别用」。
5. **不新增运行时依赖**：运行时只用 DSH 注入的 `@deepseek-ai/dsh-tools` 和 Node 内置模块；
   `typescript` / `@types/node` / ESLint 工具链（`eslint`、`@antfu/eslint-config` 等）只在 devDependencies。
6. **错误要能自解释**：配置错误抛 `ConfigError`（带 `hint`），运行错误抛 `PipelineError`；
   HTTP 错误带 `httpStatus` / `retryable`（见 `providers.ts` 的 `isRetryable`）。
7. **运行记录只写 `<项目>/.dsh/cicd-runs/`**，不要写全局目录；**不要写或修改用户的 `.gitignore`**
   （项目根的、`.dsh/` 下的都不碰）——要不要忽略运行记录由用户自己决定。
8. **dsh-pet 集成必须 best-effort**：失败静默、不阻塞工具、可配置 `pet: false` 关闭；
   dsh-pet 不在时行为与没集成完全一致。
9. **client UI 样式只用 `--dsw-*` 变量**（颜色/圆角/字体），不要写死颜色，明暗主题自动适配；
   改 `src/client/` 后必须 `pnpm build` 重新生成 `lib/client.js`。
10. **路径统一用 `node:path`**：项目根、配置、运行目录一律 `resolve` / `join`，禁止手拼 `/` 或 `\`；
    这样 Windows 的 `D:/a/b`、POSIX 的 `/a/b` 都会得到本机原生路径。
11. **lint 用 antfu 默认规则**（`@antfu/eslint-config`，`antislop` 开，`ts/no-explicit-any` 为 **error**）：
    优先写具体类型；确属动态边界（第三方 JSON、DSH 上下文、部分实现的测试桩）时，用
    `// eslint-disable-next-line ts/no-explicit-any -- 一句原因` 就地开一处，**不要全局关规则**。
12. **面向模型的文案用「意图」而不是「固定话术」**：工具 `description` / 参数说明、skill、`docs/tools.md`
    里判断「什么时候用/传什么」时，描述用户的**诉求/意图**（例如「用户要求运行结束后继续处理」），
    不要写成「用户说 X 才…」的触发词清单。示例可以留，但必须标成示例（「例如」），不能变成条件。
    `pnpm check` 会扫描这几份模型面向文案里的固定话术写法。

## 想改什么，从哪下手

| 想改的事 | 文件 |
|---|---|
| 增删工具、改参数/描述 | `src/tool-defs.ts` |
| 内部等待预算、退避、错误策略（不暴露给模型） | `src/runner.ts`（`suggestWaitSec` / `nextPollInterval` / `waitAbortReason`） |
| 新平台适配器 | `src/providers.ts` + `src/config.ts` 的 `TYPE_ALIASES` + `types.ts` |
| 云效多分支模式 | `src/providers.ts`（`isBranchMode` 检测、`CI_SOURCE_BRANCHES` 合并）+ `src/config.ts`（`branchMode`） |
| 多分支交互选择 | `src/client/index.tsx`（`shell.overlay` 弹窗，默认全选）+ `src/branch-broker.ts`（HTTP 通道）+ `src/tool-defs.ts`（`interactive` / `preview`） |
| 配置字段/校验 | `src/config.ts` |
| 环境元数据（environment / tier，只做展示） | `src/config.ts` + `src/format.ts` + `src/client/index.tsx`（弹窗徽章） |
| 凭据解析（credential-ref / 本地 env） | `src/secrets.ts`（`resolveCredential`）+ `src/runner.ts`（每次操作前解析 `tokenEnv`） |
| 配置生成 skill | `src/skill.ts`（`ctx.skills.register`，`cicd-config`）+ `test/skill.test.ts` |
| 输出文案 | `src/format.ts` |
| 进度提示（toast / 桌宠） | `src/client/index.tsx`（toast 组件）+ `src/branch-broker.ts`（notices 队列）+ `src/pet.ts`（dsh-pet，best-effort） |
| 后台跟踪/主动提示 | `src/watcher.ts`（5s→15s 轮询、冲突识别、终态 `onTerminal`）+ `src/client/index.tsx`（toast） |
| 终态/冲突唤醒（followUp） | `src/watcher.ts`（`onTerminal` / `onConflict`）+ `src/tool-defs.ts`（`followUp` 参数、`agent.followup()`）+ `src/format.ts`（`followUpText` / `conflictWakeText`） |
| 冲突信息读取 | `src/conflict.ts`（日志解析）+ `src/tool-defs.ts`（`cicd_conflict`，只读，不自动恢复） |
| 通知历史（头部入口） | `src/branch-broker.ts`（`/notices/history` + clear + `$DSH_HOME/cicd-notices.json`）+ `src/client/index.tsx`（头部 popover） |
| 设置页配置（组织/流水线/token/prefs） | `src/config-service.ts`（`/dsh-cicd/config/*`）+ `src/settings-store.ts` + `src/client/index.tsx`（`settings.section`） |
| 全局 token / 偏好 | `src/settings-store.ts` + `src/secrets.ts`（`credentials.set/describe`）+ `src/runner.ts`（每次解析全局 token） |
| 头部消息快捷入口 | `src/client/index.tsx`（`conversation.session.header.utilities` + popover，复用 history 接口） |
| 插件注册/生命周期 | `src/index.ts` |

新增平台时记得同时补：类型（`types.ts`）、配置分支（`config.ts`）、
测试（`test/providers.test.ts` 里用本地 mock server）。

## 演进循环（模型改项目时按这个走）

每一次有意义的修改，按 6 步走，不要只做第 3 步：

1. **观察**：读 `docs/spec/spec.md` 的相关章节 + `docs/adr/` 里已有的决策，再看代码。
2. **决策**：如果涉及架构取舍（换方案、加依赖、改边界），先写一篇 ADR 草稿（状态 `Proposed`），
   实现完改成 `Accepted`；不要事后补理由。
3. **实现**：改 `src/`，同步补测试（行为变了测试必须变）。
4. **同步文档**：按下面的映射表改 spec / tools / README。
5. **验证**：`pnpm check`（lint + typecheck + 测试 + 文档检查）必须全绿。
6. **记录**：被推翻的旧 ADR 标 `Superseded by ADR-XXXX`。

> 这套循环的目的：**模型改完一次项目，项目对下一个模型就更好理解一点**，
> 而不是把知识留在某次会话里。文档、ADR、测试都是给下一个模型/人看的接口。

## 文档随代码演进（强制）

行为/接口变了，文档必须在**同一个提交**里一起改。映射：

| 改动 | 同步 |
|---|---|
| 工具名 / 参数 / 返回格式 | `docs/tools.md`（章节由脚本校验） |
| 行为、状态、等待策略、错误模型 | `docs/spec/spec.md` 对应章节 |
| 架构选择（换方案、加依赖、改边界） | 新增 `docs/adr/NNNN-*.md` + 更新索引 |
| 仓库约定 / 命令 / 目录结构 | 本文件 |
| 用户可见能力 | `README.md` |

`pnpm check` 会跑 `scripts/check-docs.mjs`：必需文档缺失、ADR 缺章节/未被索引、
`docs/tools.md` 与代码注册的工具不一致、相对链接失效，都会直接失败。
所以「改了代码没改文档」在本地就会暴露，不要绕过。

## 测试与真实联调

- 单元/集成测试全部走本地 mock（`test/providers.test.ts` 起了一个 `node:http` 服务），
  不依赖外网；shell 流水线用 `node -e` 命令真跑。
- 真实云效联调（只在用户明确同意时做）：
  - 组织 ID / 流水线 ID 由用户提供，**不要写进仓库**；
  - 多分支示例需确认 `sources[].data.isBranchMode=true`；
  - 只读探测：`GET /oapi/v1/flow/organizations/{org}/pipelines`（header `x-yunxiao-token`）；
  - 触发会产生真实构建/部署，必须先征得用户同意。

## 提交前检查清单

- [ ] `pnpm check` 全绿（lint + typecheck + 测试 + 文档检查）
- [ ] 新增/修改的行为有测试（或说明为什么没有）
- [ ] `docs/spec/spec.md` 与当前行为一致
- [ ] 影响架构的改动有 ADR，`docs/adr/README.md` 索引已更新
- [ ] `docs/tools.md` 与工具面一致（脚本校验）
- [ ] 面向模型的判断条件用意图描述，没有「用户说 X 才…」这类固定话术（脚本校验）
- [ ] 没有把 token、内网地址、运行记录提交进去
- [ ] `lib/` 不进 git（已 gitignore，发布时自动构建）

