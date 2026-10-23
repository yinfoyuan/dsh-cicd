# 竞品与生态调研（2026-10）

> 目的：弄清楚「项目内的 CI 流水线插件」这个位置上有谁、我们和他们的差异在哪。
> 调研以 2026-10 的公开页面为准；星标/收录不代表背书，安装第三方插件前请自行审阅源码。

## 一、DSH 生态里的直接相似项

| 项目 | 平台 | 工具面 | 特色 | 与 dsh-cicd 的差异 |
|---|---|---|---|---|
| [ci-runner](https://deepseekharness.io/zh/plugins/ci-runner/) | GitHub Actions + 本地命令 | `ci_trigger / status / logs / watch / diagnose` | 日志有硬上限；失败后用 LLM 出根因报告；零运行时依赖；带同名 CLI | 单平台；插件级配置（`github.defaultRepo`）；没有项目级配置、多分支、云效 |
| [dsh-jenkins-panel](https://www.npmjs.com/package/dsh-jenkins-panel) | Jenkins | 22 个 `jenkins_*` 工具 | 右侧栏可视化面板；失败分析回推会话；多连接 + credential 服务 | 只有 Jenkins；有面板/诊断，dsh-cicd 还没有 |
| [dsh-jenkins](https://github.com/jsoncode/dsh-jenkins) | Jenkins | `dsh_jenkins_build / status` | 设置页、工作区入口、参数表单识别、日志/停止、中英双语 | 只有 Jenkins；项目配置在 `$DSH_HOME`，不在项目根 |

DSH 插件目录：[deepseekharness.io](https://deepseekharness.io/zh/plugins/)、[dshplugins.ai](https://dshplugins.ai/plugins)、
[dshpacks.com](https://dshpacks.com/)。

## 二、通用 MCP 生态（不是 DSH 插件，但功能重叠）

| 项目 | 能力 |
|---|---|
| [云效官方 MCP](https://help.aliyun.com/zh/yunxiao/developer-reference/cloud-effect-mcp-tool-instructions) | 194 个工具、8 大类，含 pipeline-management；官方托管 + OAuth；工具多，需要 `toolsets` 裁剪 |
| [jenkins-mcp-server](https://pypi.org/project/jenkins-mcp-server/) | trigger/stop/status/console/queue/nodes 等 9 个工具 |
| [gh-actions-mcp](https://pkg.go.dev/github.com/denysvitali/gh-actions-mcp) | 触发/取消/重跑/等待/日志 tail；固定 poll + timeout |
| [GitLab MCP](https://pypi.org/project/jmrplens-gitlab-mcp-server/) | GitLab API（含 pipeline） |
| [Claude Code DevOps 插件盘点](https://devops-daily.com/posts/best-claude-code-plugins-devops-2026) | Claude 生态里的同类能力 |

## 三、dsh-cicd 的差异点

1. **一个插件覆盖多平台**：shell + 云效 + GitLab + Jenkins + webhook，统一 `cicd_*` 工具面。
2. **项目级配置**：`.dsh/cicd.json` 按会话 cwd 隔离；`tokenEnv` 只写引用，token 走 DSH credential-ref。
3. **云效多分支语义**：自动继承 `CI_SOURCE_BRANCHES`、append/replace、自绘弹窗默认全选增减。
4. **自适应等待**：按上次耗时估预算、2s→15s 退避、401/403 立即失败、连续错误停止。
5. **原生 DSH UI**：`shell.overlay` 分支弹窗 + 居中 toast，全部走 `--dsw-*` 变量，明暗主题自动适配。
6. **工程化**：TypeScript、74 个测试、Spec/ADR/AGENTS + 文档守门。

## 四、差距与可做项

| 方向 | 参考 | 说明 |
|---|---|---|
| 失败诊断 | ci-runner `ci_diagnose` | 用 `ctx.llm` 把日志尾部变成结构化根因报告（可选、可关闭） |
| 右侧栏面板 | dsh-jenkins-panel | 运行列表/历史/日志跟随；已有 client 半边，成本可控 |
| GitHub Actions provider | ci-runner | 目前只有 shell/云效/GitLab/Jenkins/webhook |
| 凭据写入体验 | DSH credentials | 目前只读解析；可加「在设置里写入 token」的 UI |
| 发布 | 上面各插件 | npm 包 + 插件目录收录 + README 安装段 |

## 五、定位建议

**「项目级、多平台、云效优先的 CI 工具」**——不和官方云效 MCP 拼工具数量，拼
「项目隔离 + 等待/多分支/通知的体验」。发布时主打三点：多平台统一、云效多分支、原生 UI。
