# ADR-0001: 做成 DSH 插件而不是 MCP server

- 状态：Accepted
- 日期：2026-10-21

## 背景

最初的方向是每个项目放一个 `.dsh/pipeline-mcp/` + `.dsh/mcp.json` 的 MCP server。
问题：每个项目都要装一份进程、工具名带 `mcp__` 前缀、多项目时进程管理和 token
注入都要重复配置；MCP 工具注册是项目级的，无法「装一次全局可用」。

## 决策

做成 DSH（Cordis）插件：

- 插件全局装一次（`dsh plugin add`），工具名是干净的 `cicd_*`；
- 每个项目只保留 `.dsh/cicd.json` 一个配置文件；
- 工具在**调用时**从 `exec.agent.session.header.cwd` 解析项目根，
  同一个 DSH 进程里不同项目的会话天然隔离；
- 通过 `ctx.tools.register` 注册，重名只告警不中断。

## 后果

- 插件需要随 DSH 重启挂载；配置本身热更新（按 mtime 缓存）。
- 工具执行上下文必须带 `agent.session.header.cwd`，没有项目目录的会话不可用。
- 旧版 MCP 用户可以平滑迁移：保留 `cicd.json`，删除 `.dsh/pipeline-mcp/`。
