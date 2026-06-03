---
name: loongsuite-pilot-release
description: 执行版本发布流程：创建 release 分支、bump 版本、打 tag、构建上传、自动生成 Release Note 并发布到 tag。
metadata:
  requires:
    bins:
      - git
      - node
      - bash
---
# Release Skill

执行一站式版本发布。

**Input**: `/release [patch|minor|major|X.Y.Z] [--external]`

- `/release` — patch bump（默认）
- `/release minor` — minor bump
- `/release major` — major bump
- `/release 1.2.3` — 指定版本号
- 追加 `--external` 表示外部发布模式

所有步骤自动串联，无需额外确认（除发布前的版本号确认）。

---

## 执行流程

### Step 1: 前置检查

- 工作区必须干净（`git status --porcelain` 为空），否则中止
- 获取远端最新状态：`git fetch origin --prune --prune-tags --quiet`

### Step 2: 执行发布脚本

解析用户参数，映射为 `deploy/release.sh` 的选项：

| 用户输入 | 脚本参数 |
|---------|---------|
| (空) / patch | `--patch` |
| minor | `--minor` |
| major | `--major` |
| X.Y.Z | `--version X.Y.Z` |
| --external | `--external` |

执行：
```bash
bash deploy/release.sh <mapped-args>
```

脚本自动完成：fetch tags → 创建 `release/vX.Y.Z` 分支 → bump package.json → commit → tag → build → upload → push

从脚本输出提取发布的版本号 `NEXT_VERSION`。

### Step 3: 生成 Release Note

自动执行，无需用户触发。

1. 确定 tag 范围：
   ```bash
   CURRENT_TAG="v${NEXT_VERSION}"
   PREV_TAG=$(git tag -l 'v*' --sort=-v:refname | grep -v "^${CURRENT_TAG}$" | head -1)
   ```

2. 收集 commits：
   ```bash
   git log ${PREV_TAG}..${CURRENT_TAG} --format="%H %s" --no-merges
   git log ${PREV_TAG}..${CURRENT_TAG} --format="%an" --no-merges | sort -u
   ```

3. 按 conventional commit prefix 分类生成 Release Note：

   ```markdown
   ## Release vX.Y.Z

   **发布日期:** YYYY-MM-DD
   **上一版本:** <prev-version> (YYYY-MM-DD)

   ### 新功能
   - **scope**: description (`short-hash`)

   ### 问题修复
   - **scope**: description (`short-hash`)

   ### 优化重构
   - **scope**: description (`short-hash`)
   ```

   分类规则：
   - `feat` / `feature` → 新功能
   - `fix` → 问题修复
   - `refactor` / `perf` → 优化重构
   - `release:` 开头 → 跳过
   - 无 prefix 或其他 → 归入最相近的类别（根据内容语义判断），如果无法归类放入问题修复
   - 空 section 不输出

### Step 4: 发布 Release Note 到 Tag

直接执行，不再额外确认。

1. 删除远端已有的同名 tag：
   ```bash
   git push origin :refs/tags/${CURRENT_TAG}
   ```

2. 通过 `mcp__code__create_tag` 重建 tag 并附带 releaseDescription：
   - repo: 从 `git remote get-url origin` 提取仓库路径
   - tagName: `v${NEXT_VERSION}`
   - ref: tag 指向的 commit SHA
   - message: `Release v${NEXT_VERSION}`
   - releaseDescription: 生成的 Release Note 内容

### Step 5: 提示创建 CR

输出最终结果：

```
============================================================
✅ Release v${NEXT_VERSION} 发布完成

   Tag:      v${NEXT_VERSION}（含 Release Note）
   Branch:   release/v${NEXT_VERSION}
   Channel:  release
   Mode:     ${MODE}

   下一步: 创建 CR 合入 master
   运行: /submit-cr
============================================================
```

---

**护栏规则**

- 工作区不干净时中止，不自动 stash
- `deploy/release.sh` 内部会确认版本号（`Proceed with release?`），这是唯一的交互确认点
- 删除远端 tag 不需要额外确认（发布流程隐含授权）
- Release Note 生成后直接发布，不额外询问
- commit 分类基于 prefix，`release:` commit 始终跳过
