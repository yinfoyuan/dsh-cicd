# ADR-0009: 自绘 client 弹窗做分支选择（默认全选 + DSH 主题变量）

- 状态：Accepted
- 日期：2026-10-21

## 背景

通用 `ctx.userQuestions` 的问题 UI 初始 `selected: []`，协议里没有「默认选中」字段
（见 `@deepseek-ai/dsh-client-ui-user-questions`），所以「列表默认全部勾选、勾选 = 保留」
做不出来；只能反过来用「勾选 = 取消」，对用户反直觉。

用户明确要求：默认全选、勾选 = 保留、贴合 DSH UI、支持明暗主题。

## 决策

- 插件新增**浏览器半边** `src/client/index.tsx`：
  - 注册到 `shell.overlay`（`ctx.slots.inject('shell.overlay', ...)`，与 dsh-pet 同一挂载点）；
  - 复选框默认全选，勾选 = 保留；下方输入框 = 新增分支；至少一个分支才能提交。
- **样式只用 DSH 的 `--dsw-*` 变量**（`--dsw-alias-bg-layer-*`、`--dsw-alias-label-*`、
  `--dsw-radius-*`、`--dsw-alias-button-primary-fill` 等），明暗主题自动跟随，不写死颜色。
- 宿主新增 `BranchBroker`（`src/branch-broker.ts`）：
  - `GET /dsh-cicd/branch/request` 返回待选请求（client 每 1s 轮询，同时标记在线）；
  - `POST /dsh-cicd/branch/answer` 提交 `{ selected(保留), custom, cancelled? }`；
  - 5 秒内有 client 轮询才认为自定义弹窗可用。
- 同一个 client 半边还承担轻量提示：`cicd_wait` 结束/超时后，宿主往 notices 队列推一条，
  client 拉 `GET /dsh-cicd/notices?since=N` 增量弹 toast（6s 自动消失、点击可关）。
- `cicd_run interactive` 优先用自定义弹窗；client 未加载时**回退**到
  `ctx.userQuestions`（勾选 = 取消的老语义）。
- 构建：`scripts/build-client.mjs` 用 esbuild 打 CJS bundle，外层按 DSH 的
  `window.__ModuleLoader__.load({ id, factory })` 协议包装；React / jsx-runtime 由宿主提供（external）。

## 后果

- 分支选择体验与网页端一致：默认全选、勾选保留、可增删；暗色主题无需额外适配。
- 需要新增客户端构建链（esbuild）和 `dsh.client` 声明；`pnpm build` 同时产出 `lib/client.js`。
- 仍是 1s HTTP 轮询（与 dsh-pet 同款），不是 WebSocket；请求/应答简单、幂等。
- 老环境没有 client 半边时自动回退通用提问，功能不丢；两套语义在文档里写清楚。
