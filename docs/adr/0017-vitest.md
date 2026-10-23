# ADR-0017: 测试从 node:test 迁到 vitest

- 状态：Accepted
- 日期：2026-10-23

## 背景

仓库最早用 `node:test`：零额外依赖，和 ADR-0004 的「运行时零依赖」思路一致。

但 lint 用 `@antfu/eslint-config`，它的 `test/*` 规则集是按 vitest 建模的：
`--fix` 会把 `import { test } from 'node:test'` 直接改写成 vitest，`test()` 改成 `it()`。
之前为了不让自动修复改坏测试，只能在配置里关掉两条规则（`test/no-import-node-test`、
`test/consistent-test-it`），这等于在 lint 里留了一个例外。

## 决策

测试框架换成 vitest：

- 测试文件从 `node:test` 改为 `import { afterAll, beforeAll, it } from 'vitest'`；
- 测试文件用 TypeScript（`test/*.test.ts`），由 vitest 的 esbuild 转译；
- 新增 `test/tsconfig.json`（include `test` + `src`，继承根配置的 `strict`）并挂进 `typecheck`，
  测试因此也进严格类型检查；`test/` 下的就近配置同时让编辑器识别它，CLI 与编辑器用同一份规则；
- 断言继续用 `node:assert/strict`（vitest 下可直接使用，不强制改 `expect`）；
- `vitest.config.ts` 指定 `include: ['test/**/*.test.{mjs,ts,tsx}']`、`environment: 'node'`、
  30s 超时（有用例起本地 HTTP mock、spawn 子进程、等真实计时）；
- 测试直接 `import '../src/*.js'`（vitest 用 esbuild 转译 TS，`./x.js` 会解析到 `x.ts`），
  `pnpm test` 不再先 build；
- `pnpm check` 仍然跑一次 `build`，确保 `tsc` 输出和 `lib/client.js` 没问题；
- ESLint 里删掉那两条例外，`test/*` 规则按默认生效。

## 后果

- devDependencies 多一条 vitest 及其依赖；运行时依旧零第三方依赖，包体积不变。
- 可以用 vitest 的过滤、watch、coverage 等能力，测试输出也比 `node --test` 更清晰。
- 测试不再验证编译产物层（`lib/`）——产物由 `pnpm check` 里的 build 和发布前的
  `prepack` 覆盖；单测报错行号直接指向 `src/`，改代码后免 build 即可跑。
- 测试纳入严格类型检查：桩对象用显式 `any` 标注（隐式 any 不允许），
  `pnpm typecheck` 同时检查 host / client / test 三套配置。
- 执行模型从「每个测试文件一个 node 进程」变成 vitest 的 worker（默认 forks）；
  依赖真实计时的用例要留意并行与超时，必要时单独圈出来串行跑。
- ADR-0004 里「测试继续用 `node:test`」这一条被本篇取代；其余结论
  （tsc 构建、运行时零依赖、`lib/` 不进 git）不变。
