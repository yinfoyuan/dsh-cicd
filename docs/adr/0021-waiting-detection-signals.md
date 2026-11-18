# ADR-0021: 「等待人工确认」只认显式人工信号，且要连续两轮确认

- 状态：Accepted
- 日期：2026-11-18

## 背景

`record.waiting` 由 `providers.findManualGate` 推断，watcher 一旦看到就推
`⏸ 等待人工确认`，`followUp: true` 时还会唤醒模型。误报的代价比晚报大：
用户被叫去云效处理一个根本不存在的人工卡点。

实机运行（一个 3 阶段流水线：分支集成 / 命令 / 部署，**没有任何人工卡点**）：

- 通知历史显示 `⏸ 等待人工确认：阶段「命令」` 只存在**一个轮询周期**（09:51:22 → 09:51:38 就变成
  「人工确认已完成」）；
- 云效 run 明细里 `stage 命令.startTime = 09:51:21`，即阶段**刚被调度 1 秒**；
- 用 1s 粒度只读轮询抓「命令 → 部署」切换，阶段一完成就 `INIT → RUNNING`（1 秒内），没有等待态——
  说明等待态只出现在阶段**首次调度**的短暂窗口里。
- 随后用更高频的捕获（约 0.4s/次，从触发前就开始等）抓到的原始报文：

  ```
  10:16:58.683  stage 命令 = RUNNING   job 执行命令 = RUNNING
  10:16:59.460  stage 命令 = WAITING   job 执行命令 = WAITING   actions=[StopPipelineJobRun]
  run.status = WAITING
  ```

  即**阶段在排队等构建机**（当时并发跑了另一条 run，等了一分多钟），
  和人工卡点无关，`actions[]` 里也没有 `ExecutePipelineJobRun`。
  把这一帧喂给旧实现：`findManualGate` 命中 `阶段「命令」`（走 `SWITCH_MANUAL` 之外的状态兜底）；
  喂给新实现：`null`，进度文案为 `阶段 2/3 · 命令（等待调度）`。

旧判定有三个口子会把这种抖动当成人等人：

1. `STAGE_WAITING` 里有 `WAITING` / `PAUSED` / `SUSPEND`——这些是平台排队、等执行机、挂起，
   不是「等人点按钮」；
2. `findManualGate` 只要 job `actions[]` 出现 `ExecutePipelineJobRun` 就判「手动触发阶段」，
   而普通 job 在待调度时也可能带这个动作；
3. 兜底分支不看阶段是否真的 `SWITCH_MANUAL`。

## 决策

- **只认显式人工信号**：
  - 人工卡点 = job `actions[]` 含 `PassPipelineValidate` / `RefusePipelineValidate*`
    （审批门独有，出现即认定，阶段状态可以是 `RUNNING`）；
  - 手动触发阶段 = 阶段状态 `SWITCH_MANUAL`（或 `WAITING_MANUAL`）**且** job action 含
    `ExecutePipelineJobRun`；阶段状态本身就是 `SWITCH_MANUAL` 时兜底按 `start` 报。
- **普通等待态不算等人**：`WAITING`（排队/等调度）从人工等待集合里移除，改为独立信号
  `record.queued`，`progress` 显示 `（等待调度）`；watcher 排队满 90 秒补一条「在等执行机」
  （只一次、不唤醒）；
  `PAUSED` / `SUSPEND` 只在展示上算「等人工」（要人恢复，但没有可点动作），不进 `waiting`。
- **连续两轮确认**：watcher 要连续两个轮询周期看到**同一处**等待才推 toast / 唤醒；
  真正的卡点是分钟级的，误报只活一个周期。取消（`muteWaiting`）语义不变。

## 后果

- 阶段调度瞬间不再误报；用户不会被叫去处理不存在的人工卡点。
- 真实卡点的通知最多晚一个轮询周期（≤15s），可接受；`cicd_status` 的 `waiting` 字段
  仍如实反映**当次**平台状态（可能短暂出现一次抖动，但不推送、不唤醒）。
- **实机复核**：手动触发阶段（`SWITCH_MANUAL` + `ExecutePipelineJobRun`）
  走 `/start`、审批卡点（`PassPipelineValidate`，阶段与 job 状态同样是 `WAITING`）走 `/pass`，
  两条路径都在真实流水线上验证通过。审批卡点的状态和排队撞，所以 `progress` 也必须用
  action 判据，只靠状态会让同一阶段同时显示「等待人工确认」和「排队等执行机」。
- 手写 fixture 覆盖两种形态：`WAITING` + `ExecutePipelineJobRun` 的普通阶段不报，
  `SWITCH_MANUAL` + `ExecutePipelineJobRun` 的手动阶段照旧报（`test/providers.test.ts`、
  `test/watcher.test.ts`）。
- 代价：如果云效某天改用非 `SWITCH_MANUAL` 的状态表示人工卡点，需要重新确认枚举
  （已按「真实审批卡点」与「排队等待」两个实机样本校准）。
