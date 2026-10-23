# 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)，`commit-msg` hook 会校验。

## 格式

```text
<type>(<scope>): <subject>
```

常用 type：

| type | 用途 |
|---|---|
| `feat` | 新能力 |
| `fix` | 修 bug |
| `docs` | 文档 |
| `refactor` | 重构，不改变行为 |
| `test` | 测试 |
| `chore` | 构建/依赖/发布等杂项 |
| `perf` | 性能 |
| `ci` | CI 配置 |

示例：

```text
feat(settings): 增加环境筛选
fix(pet): 兼容 dsh-pet 0.3.8 的 config 形状
docs: 重写接入流程
chore(release): v0.1.0
```

## 校验

- 本地：`.husky/commit-msg` 调用 commitlint；
- CI：PR 校验整个 PR 的提交范围，push 校验最后一个提交。

```powershell
# 手动校验
'feat: 示例' | pnpm exec commitlint
```

## 与发布的关系

`release-it` 用 Conventional Commits 自动生成 `CHANGELOG.md`，并决定下一个版本：

- `fix:` → patch
- `feat:` → minor
- `BREAKING CHANGE:` / `!` → major

所以提交信息不是形式主义，会直接影响版本号和 changelog。
