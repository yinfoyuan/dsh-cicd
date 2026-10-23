import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试直接 import src/*.ts（vitest 用 esbuild 转译，不需要先 build）
    include: ['test/**/*.test.{mjs,ts,tsx}'],
    environment: 'node',
    // 有几个用例要起本地 HTTP mock / spawn 子进程 / 等真实计时
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
