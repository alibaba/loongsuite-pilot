---
name: /submit-cr
id: submit-cr
category: Workflow
description: 创建 CR 并执行 Code Review，发布评审意见到 CR
---

创建 CR（Merge Request）并自动执行 Code Review，将评审意见发布到 CR。

**Input**: 可选参数 `<target-branch>`，指定合入目标分支（默认 `master`）。

---

## Phase 1: 创建 CR

1. **检测当前分支**

   ```bash
   git branch --show-current
   ```

   - 若当前分支是 `master` 或 `main`，**中止执行**，提示用户切换到 feature 分支。
   - 记录当前分支名为 `<source-branch>`。

2. **确保代码已推送到远端**

   检查当前分支是否有未推送的 commit：

   ```bash
   git log origin/<source-branch>..HEAD --oneline 2>/dev/null
   ```

   - 若有未推送的 commit，或远程分支不存在，提示用户确认后执行 `git push origin <source-branch> -u`。
   - 若有未提交的变更（`git status` 非 clean），**暂停**并提示用户先提交。

3. **认证 `code` MCP 服务器**

   使用 `code` MCP 服务器操作 CR。首次使用时需要 OAuth 认证：
   - 调用 `mcp__code__authenticate` 获取授权 URL
   - 引导用户在浏览器中完成授权
   - 调用 `mcp__code__complete_authentication` 完成认证

   若已认证则跳过。

4. **检查是否已存在 CR**

   通过 `code` MCP 查询当前分支是否已有指向 `<target-branch>`（默认 `master`）的 Merge Request：
   - 若已存在且状态为 open：输出 CR 链接，跳过创建，直接进入 Phase 2。
   - 若已存在但状态为 merged/closed：允许创建新 CR。

5. **创建 Merge Request**

   通过 `code` MCP 创建 Merge Request：
   - source branch: `<source-branch>`
   - target branch: `<target-branch>`（默认 `master`）
   - title: 从最近的 commit 消息或分支名生成简洁标题
   - description: 包含变更摘要（可从 `git log <target-branch>..<source-branch> --oneline` 生成）

6. **输出 CR 链接**

   ```
   CR 已创建: <CR link>
   ```

## Phase 2: Code Review + 发布评审意见

1. **执行 Code Review**

   调用 `/code-review` 技能工作流，对 `<source-branch>` vs `<target-branch>` 的变更进行完整评审：
   - 遵循 code-review skill 的全部阶段（Preflight → Context Building → Intent Analysis → Sub-agent Review → Final Report）
   - 评审报告落盘到 `code-review/branch-<branchName>/`

2. **发布评审意见到 CR**

   评审完成后，code-review 技能的 Phase 6 会自动将结果发布到 CR（GitLab 平台）：

   - **Inline Findings**：将 Critical/High/Medium 级别的可定位问题逐条作为代码行内评论发布（使用 `mcp__code__comment_merge_request_changed_file`）
   - **CR 摘要评论**：将 Final Report 摘要发布到 CR 全局评论（使用 `mcp__code__comment_merge_request`）
     - 包含：Critical/High/Medium/Low 数量统计、Lifecycle PASS/FAIL 表格、总体结论、Highlights
   - 发布结果记录到 `code-review/<target>/publish-result.json`
   - 若 `code` MCP 发布失败，输出失败原因并给出可复制的发布内容

---

**输出**

```
## CR 提交完成

**分支:** <source-branch> → <target-branch>
**CR:** <CR 链接>
**评审:** 已发布（共 N 个发现：X 严重、Y 高危、Z 中危、W 低危）

CR 已就绪，等待人工评审。
```

**失败输出**

```
## CR 提交失败

**阶段:** <失败阶段>
**原因:** <失败原因>
**恢复建议:** <建议的后续步骤>
```

---

**护栏规则**

- 必须在 feature 分支上执行，禁止从 master/main 创建 CR
- 推送代码前必须获得用户确认
- CR 创建前检查重复，避免产生多个相同 CR
- Code Review 遵循 code-review skill 的完整流程，不可跳过
- 发布评审意见前不需要额外确认（本 skill 的调用本身即为用户意图确认）
