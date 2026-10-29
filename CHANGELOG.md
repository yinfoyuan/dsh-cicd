# Changelog

## [0.3.0](https://github.com/yinfoyuan/dsh-cicd/compare/v0.2.0...v0.3.0) (2026-10-29)

### Features

* 识别等待人工确认并主动提醒 ([46eb81e](https://github.com/yinfoyuan/dsh-cicd/commit/46eb81e024dabee151bf59d08d9e02384dc74b51))
* 手动阶段拒绝等价取消运行 ([4ca772b](https://github.com/yinfoyuan/dsh-cicd/commit/4ca772b655977587804dc1ca4db34d64ff979739))
* 云效触发支持运行参数（comment/envs/tags/制品） ([1bb380f](https://github.com/yinfoyuan/dsh-cicd/commit/1bb380f449239e7b98f6ad074457664bbb366c1c))
* 云效运行变量只读副本与 cicd_vars ([4cf483f](https://github.com/yinfoyuan/dsh-cicd/commit/4cf483f9e09e50ed88a4587f040151c6d967b801))
* 云效运行历史与人工卡点审批 ([1f8dee4](https://github.com/yinfoyuan/dsh-cicd/commit/1f8dee4fcc9004c26f81736a5e08fb3f129a3b38))
* 运行变量覆盖预填到弹窗 ([20ac998](https://github.com/yinfoyuan/dsh-cicd/commit/20ac998559f88b87f2a3227081f3884434c309ba))
* 运行配置弹窗（runConfig） ([49412cb](https://github.com/yinfoyuan/dsh-cicd/commit/49412cb9efa63d6049338a0e184a2cbecd89764e))
* 运行配置弹窗预填运行备注 ([a3e3c2f](https://github.com/yinfoyuan/dsh-cicd/commit/a3e3c2f9db00b47dfbde1a926825a770629e2041))

### Bug Fixes

* 变量读取失败时不回显响应体 ([e16f052](https://github.com/yinfoyuan/dsh-cicd/commit/e16f0525d25887b4e232fefdf00a30c0b6faca14))
* 等待人工确认提示文案去重 ([ed46448](https://github.com/yinfoyuan/dsh-cicd/commit/ed46448a332798162d3f6fed58897508ad101745))
* 分支确认不再被 runConfig:false 或 branches 跳过 ([c3b3161](https://github.com/yinfoyuan/dsh-cicd/commit/c3b31614fb1bde31928e196f8ef47e1a45ec92e2))
* 区分人工卡点与手动触发阶段 ([8eb06e4](https://github.com/yinfoyuan/dsh-cicd/commit/8eb06e47a1f465e9e773b79fda60ab5aa3af4f67))
* 取消标记不被后台轮询覆盖 ([3643fe8](https://github.com/yinfoyuan/dsh-cicd/commit/3643fe87f9695d943c8bcc2a0452b3d0c54931a3))
* 取消后抑制在途的等待提醒 ([0b1ec0e](https://github.com/yinfoyuan/dsh-cicd/commit/0b1ec0ee89268a6b5f32f9ac714d999e36a0dfee))
* 取消记录清掉等待态 ([3163b2f](https://github.com/yinfoyuan/dsh-cicd/commit/3163b2f89717f27543d4230ca6206d97b5ae8e86))
* 运行配置弹窗内容滚动 ([9d1b522](https://github.com/yinfoyuan/dsh-cicd/commit/9d1b5226a826c6a37437036d7fa083c8d466db71))

## [0.2.0](https://github.com/yinfoyuan/dsh-cicd/compare/v0.1.0...v0.2.0) (2026-10-23)

### Features

* 触发后支持 followUp 自动唤醒，后台追踪不再阻塞 ([0170b5b](https://github.com/yinfoyuan/dsh-cicd/commit/0170b5b1346fc2738e8782ffb8919b7de698b724))
