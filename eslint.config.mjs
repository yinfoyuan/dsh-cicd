import antfu from '@antfu/eslint-config'

export default antfu(
  {
    // 这是 DSH 插件库，不是应用
    type: 'lib',

    // client 半边是 React（src/client/index.tsx）
    react: true,

    // 抓重复/AI 味代码
    antislop: true,

    ignores: [
      'lib/**',
      'coverage/**',
      '.dsh/**',
      'examples/**/.dsh/**',
      'CHANGELOG.md',
      'pnpm-lock.yaml',
      // 文档里的代码块是配置示例/伪代码，不是可解析的 TS
      '**/*.md',
    ],
  },
  {
    rules: {
      // 显式 any 一律报错：能写具体类型就写具体类型；
      // 确实是动态边界（第三方 JSON、DSH 上下文）时，用
      // `// eslint-disable-next-line ts/no-explicit-any -- 原因` 就地说明。
      'ts/no-explicit-any': 'error',
    },
  },
)
