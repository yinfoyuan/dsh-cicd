# ADR-0004: TypeScript + tsc 构建，运行时不引入第三方依赖

- 状态：Accepted
- 日期：2026-10-21

## 背景

项目最初是纯 JavaScript（ESM），没有类型和构建。随着适配器、等待策略、错误模型变多：

- 跨模块契约（RunRecord、Provider、WaitMeta）靠约定，改字段容易漏；
- 发布形态只有 `src/index.js`，没有 `.d.ts`，集成方无法获得类型提示；
- 工程要按「智能体工程」演进，需要可 typecheck、可测试、可发布的构建链。

也考虑过不构建、直接用 Node 24 的类型剥离跑 `.ts`，以及引入 vitest、tsdown 等工具。

## 决策

- 源码 `src/*.ts`，`tsc`（NodeNext + strict + declaration）构建到 `lib/`；
- `package.json` 的 `main` / `types` / `exports` 指向 `lib/`，`files` 同时包含 `src`；
- **运行时零第三方依赖**：只用 DSH 注入的 `@deepseek-ai/dsh-tools` 和 Node 内置模块；
- 开发依赖只有 `typescript`、`@types/node`；测试继续用 `node:test`（不需要额外框架）；
- 测试 import 编译后的 `lib/`，`pnpm test` 先构建再跑。

## 后果

- 类型成为契约的一部分，`pnpm typecheck` 进 CI（`pnpm check`）。
- 发布包含 `.d.ts` 与 sourcemap；使用方获得类型。
- 测试跑的是产物而不是源码，构建失败会直接暴露；代价是改完必须构建。
- 没有引入打包器：`tsc` 输出的 ESM 已满足 DSH 的加载方式，少一个工具链。
- `lib/` 是 gitignore 的构建产物，发布/本地 link 安装前先 `pnpm build`。
