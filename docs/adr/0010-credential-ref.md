# ADR-0010: token 通过 DSH credential-ref 解析

- 状态：Accepted
- 日期：2026-10-21

> 后续变更：项目 `.env` / `.dsh/.env` 支持已移除；token 只从 DSH 凭据、进程环境变量、
> `~/.dsh/.credentials.yaml` 读取。credential-ref 方案本身不变。

## 背景

最初 token 由插件自己按顺序读 `~/.dsh/.credentials.yaml`、`process.env`、项目 `.env`、
`.dsh/.env`。DSH 已有 credential-reference seam：`ctx.credentials`（`@deepseek-ai/dsh-credentials`），
provider 负责真实的凭据存储与源层，消费者只拿到「引用」并在每次操作时解析——配置面永远看不到值，
改凭据下一次操作即生效。`dsh-jenkins-panel` 等插件已经这么用。

## 决策

- `tokenEnv` 的变量名**同时就是 credential ref**，不新增配置字段。
- 新增 `secrets.resolveCredential(ctx, ref)`：优先 `ctx.credentials.resolve(ref)`；
  服务不存在、未配置或解析报错都返回 `undefined`，由调用方回退到原有的本地合并逻辑。
- `Runner` 持有插件 ctx；四个出站调用点（trigger / poll / logs / cancel）都先解析一次
  `tokenEnv`，解析到值就覆盖 `project.env` 里的同名项。
- 不新增运行时依赖：seam 通过 `ctx.get('credentials', false)` 访问，不 import 包。

## 后果

- token 可以只放在 DSH 管理的凭据层，插件不直接读明文；改凭据不用重启。
- 老版本 DSH 没有该服务时回退到进程环境变量 / `~/.dsh/.credentials.yaml`。
- 每次操作多一次 `resolve()`（本地读，开销很小）；解析失败静默回退，不阻塞流水线操作。
