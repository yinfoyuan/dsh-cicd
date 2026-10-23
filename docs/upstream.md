# 上游跟进

记录我们依赖的外部项目、向上游提的建议，以及当前处理方式。
只做记录，不自动跟进；需要推进时再单独安排。

| 项目 | 事项 | 状态 | 对我们的影响 | 处理方式 |
|---|---|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | [issue #161](https://github.com/PC2005-cloud/dsh-pet/issues/161)：建议为宿主侧插件提供公开 API | Open（2026-10-21 提交，暂无回复） | 无。当前通过 `/dsh-pet-7340/broadcast` 已可用 | 保持现状；等上游提供公开 API 后只需替换 `src/pet.ts` 的实现。预计作者自行完成，暂不主动提 PR。 |

## 相关决策

- [ADR-0006：通过 dsh-pet 的 broadcast 路由做进度提示](./adr/0006-pet-progress-notifications.md)
