# 发布流程

使用 **npm Trusted Publishing（OIDC）**，不保存长期 npm token。

要求：

- 仓库 public；
- GitHub-hosted runner；
- npm CLI ≥ 11.5.1、Node ≥ 22.14（workflow 会安装 npm 11）。

## 一次性：首次发布 + 配置 Trusted Publisher

npm 的 Trusted Publisher 配置在**已存在的包**的 Settings 里，所以第一个版本要先手动发布一次：

```powershell
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
```

发布成功后，打开：

```
https://www.npmjs.com/package/dsh-cicd/access
```

在 **Trusted Publisher** 里添加 GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization or user | `yinfoyuan` |
| Repository | `dsh-cicd` |
| Workflow filename | `release.yml` |
| Environment name | 留空 |
| Allowed actions | 勾选 publish |

然后：

1. 删除 GitHub 仓库的 `NPM_TOKEN` secret（如果建过）；
2. 删除本地 npm 的 Automation / Granular token；
3. 之后不要再把 npm token 写进 CI。

## 后续发版

```powershell
pnpm release:dry
pnpm release patch   # 或 minor / major
```

`release-it` 会生成 CHANGELOG、更新版本、提交并推送 `v*` tag。

GitHub Actions `release` 工作流会：

- 校验 tag 与版本；
- `pnpm check`；
- 用 GitHub OIDC 调 `npm publish --provenance`；
- 创建 GitHub Release。

如果该版本已经存在，工作流会跳过 npm publish，只补 Release。

## 验证

```powershell
npm view dsh-cicd version
dsh plugin --profile test add dsh-cicd
```
