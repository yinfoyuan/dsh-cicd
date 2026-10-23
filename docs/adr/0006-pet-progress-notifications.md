# ADR-0006: 通过 dsh-pet 的 broadcast 路由做进度提示

- 状态：Accepted
- 日期：2026-10-21

## 背景

用户希望「等待流水线时能看到进度提示」，最好由桌宠 dsh-pet 说出来，例如：
轮询结束时提示「某某 还在执行」。

调查 dsh-pet 后发现：它的宿主半边没有暴露 Cordis service，而是把能力挂在
DSH webServer 的路由表上，其中 `/dsh-pet-7340/broadcast` 正是给宿主侧其他插件用的：

- `POST /dsh-pet-7340/broadcast?pet=<id>`
- body `{ "text": "...", "image"?: "表情包名" }`（image 只认池内名字，防止注入外部地址）
- 写入 `S.pets.<id>.say`，前端 1s 轮询 `/state` 后弹气泡；只回 `{ ok }`。

## 决策

- dsh-cicd 不依赖 dsh-pet 的类型/服务：运行时用 `ctx.get('webServer', false)` 拿端口，
  `POST http://127.0.0.1:<port>/dsh-pet-7340/broadcast`，body `{ text }`。
- **best-effort**：1.5s 超时、所有失败静默、不阻塞工具返回；路由 404 或网络失败后
  在本进程内禁用，避免每条等待都重试。
- 提示时机只放在 `cicd_wait` 结束：
  - 超时/仍在运行 → `⏳ <title> 还在执行（已等 X） · <阶段进度>`；
  - 终态 → `✅ 执行成功 / ❌ 执行失败 / ⛔ 已取消`。
- 插件配置 `pet: false` 可整体关闭；`pet` 默认开启。

## 后果

- 装了 dsh-pet 就自动有气泡进度；没装时零影响、零报错。
- 依赖 dsh-pet 的**路由契约**（非公开 API）——版本变化可能失效；
  通过「失败静默 + 可关闭 + 独立模块 `src/pet.ts`」把风险限制在提示功能内。
- 未来 dsh-pet 若暴露 Cordis service 或事件总线，只需替换 `src/pet.ts` 的实现。
- 不做重试/排队：提示是锦上添花，丢一条不影响流水线本身。

## 后续

- 2026-10-21：向上游提交建议
  [dsh-pet#161](https://github.com/PC2005-cloud/dsh-pet/issues/161)，希望提供公开 API；
  跟进状态记录在 [../upstream.md](../upstream.md)。
- 在公开 API 出现之前继续使用 `broadcast`；出现后只需替换 `src/pet.ts` 的实现，
  其余代码与测试不用动。
