# ADR-0015: 设置页保留最近通知历史

- 状态：Superseded by ADR-0016
- 日期：2026-10-22

## 背景

toast 只停留 6 秒，用户走神/切窗口就会错过。需要能事后回看「刚刚那条流水线提示说了什么」。

## 决策

- 宿主 `BranchBroker` 保留最近 200 条 notice（`seq / text / level / at / project`），新增：
  - `GET /dsh-cicd/notices/history?limit=50`：最新在前；
  - `POST /dsh-cicd/notices/clear`：清空。
- 历史**落盘**到 `$DSH_HOME/cicd-notices.json`（默认 `~/.dsh/`），是**全局**的，
  不属于某个项目；每条带 `project`（触发它的项目根），设置页显示项目名。
- client 半边注册 `settings.section`（label「流水线通知」）：打开设置时每 2s 拉一次历史，
  展示「时间 + 项目 + 文本」，支持「清空」。

## 后果

- 错过 toast 后可以在 设置 → 流水线通知 里回看；不需要扩大 toast 停留时间。
- 跨工作目录共享同一份历史：A 项目触发的消息在 B 项目会话里也能看到（按项目标签区分）。
- DSH 重启后历史仍在（内存 + 文件）；文件损坏/缺失时按空历史处理。
- 设置页打开时每 2s 一次本地 HTTP 请求，开销可忽略；落盘失败静默，不影响通知。
