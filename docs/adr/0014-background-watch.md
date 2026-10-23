# ADR-0014: 触发后后台跟踪，`cicd_wait` 只做显式阻塞

- 状态：Accepted
- 日期：2026-10-22

## 背景

实测触发云效多分支流水线时遇到三个问题：

1. 长运行（2 分钟以上）期间没有任何提示，用户以为卡住；合并冲突/取消后也没有明确提示；
2. `cicd_wait` 是阻塞调用，会把对话卡住，用户不能继续做别的事；
3. 多分支流水线在未传 `interactive` 时直接按上次分支集运行，没有弹窗。

## 决策

- 新增 `RunWatcher`（`src/watcher.ts`）：`cicd_run` 返回后后台轮询（5s 起，逐步退避到 15s，
  最长 45 分钟）：
  - 阶段进度变化 → toast/桌宠；
  - **分支集成冲突暂停**（日志出现「Merge conflicted, job paused / 冲突（内容）/ 自动合并失败」）
    → 提示「需要手动合并：请在云效解决冲突后点 Conflict Resolved」，每次运行只推一次；
  - 终态 → ✅/❌/⛔；失败时读日志尾部，识别「合并冲突 / 用户已取消」并附在提示里。
- 同一 `runId` 只跟踪一次；DSH 重启后跟踪器丢失（记录仍在，可 `cicd_status` 查）。
- `cicd_wait` 改为**只查一次状态**（不阻塞、无 `block` 参数）：运行结束由后台跟踪通知，
  工具层不再提供等待模式（内部 `Runner.wait` 保留，但不对模型暴露）。
- 多分支自动弹窗：`cicd_run` 在**未传 branches / interactive** 且是云效多分支时自动弹窗；
  弹窗不可用（无 client、无 userQuestions、查询失败）时回退默认 append，不阻断运行；
  `interactive:false` 关闭，显式 `branches` 跳过。
- `summarizeStages` 优先用 `stageInfo.status`，并让失败阶段优先于「运行中」阶段显示。

## 后果

- 触发后对话立即空闲，用户可继续工作；进度和失败原因通过 DSH 原生 toast / dsh-pet 到达。
- 后台跟踪是内存态，DSH 重启/插件重载会丢失；运行记录本身已落盘，仍可查询。
- 自动弹窗对「只想沿用上次分支」的用户多一步；可用 `interactive:false` 或显式 `branches` 跳过。
