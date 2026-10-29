# 文档导航

| 文档 | 读者 | 内容 |
|---|---|---|
| [README](../README.md) | 使用者 | 安装、配置示例、字段说明、排错 |
| [AGENTS.md](../AGENTS.md) | 在本仓库工作的智能体 | 仓库地图、命令、不可破坏的约定、提交检查清单 |
| [docs/tools.md](./tools.md) | 模型 / 集成方 | 九个工具的参数、默认值、行为、示例输出 |
| [docs/spec/spec.md](./spec/spec.md) | 开发者 / 评审者 | 功能与非功能需求、数据模型、验收标准、变更流程 |
| [docs/adr/README.md](./adr/README.md) | 开发者 / 评审者 | 架构决策记录索引（为什么这么设计） |
| [docs/roadmap.md](./roadmap.md) | 产品 / 开发者 | 云效迭代排期：P0/P1/P2、平台接口、验收节奏 |
| [docs/landscape.md](./landscape.md) | 产品 / 开发者 | 竞品与生态调研、差异点、可做项 |
| [docs/environments.md](./environments.md) | 产品 / 开发者 | 测试/正式环境的建模调研与建议 |
| [docs/upstream.md](./upstream.md) | 开发者 | 上游依赖与建议的跟进记录 |

## 文档演进规则（必须）

改代码时，按下面的映射同步文档；`pnpm check` 会跑 `scripts/check-docs.mjs`，
结构性问题（缺文件、ADR 缺章节、工具文档与代码不一致、相对链接失效）会直接失败。

| 改动 | 必须同步 |
|---|---|
| 工具名 / 参数 / 返回格式 | `docs/tools.md`（章节由脚本校验） |
| 行为、状态、等待策略、错误模型 | `docs/spec/spec.md` 对应章节 |
| 影响架构的选择（换了方案、引入新依赖、改变边界） | 新增一篇 `docs/adr/NNNN-*.md` + 更新索引 |
| 仓库约定 / 命令 / 目录结构 | `AGENTS.md` |
| 用户可见能力 | `README.md` |

> 一句话：**文档不是事后补的，是和代码同一个提交里的。**

## 演进循环

每次有意义的修改按 6 步走（详见 [AGENTS.md](../AGENTS.md#演进循环模型改项目时按这个走)）：

1. 观察：读 spec 的相关章节 + 已有 ADR；
2. 决策：架构取舍先写 ADR（Proposed → Accepted）；
3. 实现：代码 + 测试；
4. 同步文档：spec / tools / README；
5. 验证：`pnpm check`；
6. 记录：被推翻的旧 ADR 标 `Superseded by ADR-XXXX`。

目标：**模型改完一次项目，项目对下一个模型就更好理解一点**——知识沉淀在仓库里，
而不是留在某次会话里。
