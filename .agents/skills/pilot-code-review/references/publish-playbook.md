# 发布 Playbook（Phase 6 平台机械细节）

本文件收纳 Phase 6 各平台发布的**机械操作细节**（命令、通道探测、API、schema）。
决策与策略（是否发布、评论格式、回复/关闭规则、合入门禁裁决）留在 `SKILL.md` Phase 6，本文件只被按需加载执行。

发布对象与前置：`platform` 取值 `github` / `gitlab`；发布内容 = inline findings + summary + 历史评论回复/关闭 + 门禁裁决动作。

---

## 1. GitHub 平台发布流程（platform == "github"）

1. **获取 PR head commit SHA**：
   ```bash
   gh pr view <pr-number> --json headRefOid --jq '.headRefOid'
   ```

2. **发布 Inline Findings**（逐条）：
   ```bash
   gh api repos/<owner>/<repo>/pulls/<pr>/comments \
     -f commit_id="<head_sha>" \
     -f path="<file_path>" \
     -F line=<line_number> \
     -f side="RIGHT" \
     -f body="<formatted_comment>"
   ```

3. **发布 Summary Comment**：
   - 先将摘要写入临时文件 `code-review/<target>/platform-summary.md`
   - 然后：
   ```bash
   gh pr comment <pr-number> --body-file code-review/<target>/platform-summary.md
   ```

4. **记录发布结果**：在 `final-report.md` 末尾追加 "Platform Publish" 小节，记录发布时间和结果。

---

## 2. GitLab（Code 平台）发布流程（platform == "gitlab"）

按以下优先级选择发布通道：

### 通道选择（自动探测，逐级降级）

| 优先级 | 通道 | 探测方式 | 适用场景 |
|--------|------|----------|----------|
| 1 | MCP（`mcp__code__*`） | 尝试调用 `mcp__code__get_merge_request_detail`，成功即可用 | 交互式 Claude Code 会话、MCP server 在线 |
| 2 | GitLab API（`curl`） | 检查 `GITLAB_TOKEN` 环境变量或 `~/.gitlab-token` 文件 | MCP 不可用、headless/CI 环境、OAuth 过期 |
| 3 | 手动输出 | 兜底：将评论内容完整输出到聊天和落盘文件 | 无任何认证可用 |

探测逻辑（必须按顺序执行）：

1. 尝试 MCP：调用 `mcp__code__get_merge_request_detail`，若返回正常数据 → 使用通道 1。
2. 若 MCP 调用超时、报错、或工具不存在 → 检查 GitLab token：
   - 优先读取环境变量 `GITLAB_TOKEN`
   - 其次读取 `~/.gitlab-token` 文件（首行为 token）
   - 验证 token：`curl -s -o /dev/null -w "%{http_code}" -H "PRIVATE-TOKEN: $token" "https://gitlab.alibaba-inc.com/api/v4/user"`
   - 返回 200 → 使用通道 2
3. 若 token 也不可用 → 使用通道 3（手动输出），并在 `publish-result.json` 标记 `channel: "manual"`。

在 `publish-result.json` 中记录实际使用的 `channel`（`mcp` / `gitlab_api` / `manual`）。

### 通道 1：MCP 发布

1. **获取 MR 信息**：
   - 使用 `mcp__code__get_merge_request_detail` 确认 MR 状态为 `opened`。
   - 使用 `mcp__code__list_merge_request_changed_files` 获取变更文件列表，确保 inline 评论的 path 在变更范围内。

2. **发布 Inline Findings**（逐条）：
   - 对每个有明确 `path` + `line` 的 Finding，使用 `mcp__code__comment_merge_request_changed_file`：
     - `repo`: 仓库路径（如 `sls/loongsuite-pilot`）
     - `mergeRequestId`: MR ID
     - `path`: 变更文件路径
     - `line`: 新文件行号
     - `note`: 格式化的评论内容

3. **发布 Summary Comment**：
   - 使用 `mcp__code__comment_merge_request`：
     - `repo`: 仓库路径
     - `mergeRequestId`: MR ID
     - `note`: 摘要评论内容（同 SKILL.md 6.2-B 格式）

4. **记录发布结果**：在 `final-report.md` 末尾追加 "Platform Publish" 小节。

### 通道 2：GitLab API 直调（MCP 降级）

当 MCP 不可用时，通过 `curl` 直接调用 GitLab REST API：

**前置：解析仓库信息**

```bash
# 从 git remote 提取 repo path（如 sls/loongsuite-pilot）
GITLAB_REPO=$(git remote get-url origin | sed -E 's|.*gitlab\.alibaba-inc\.com[:/](.+?)(\.git)?$|\1|')
# 对 repo path 做 URL encode（/ → %2F）
GITLAB_REPO_ENCODED=$(echo "$GITLAB_REPO" | sed 's|/|%2F|g')
# Token（环境变量优先，否则从文件读取）
GITLAB_TOKEN="${GITLAB_TOKEN:-$(cat ~/.gitlab-token 2>/dev/null | head -1)}"
GITLAB_API="https://gitlab.alibaba-inc.com/api/v4"
```

**1. 获取 MR IID**（若只有 branch 名，需要先查询对应 MR）：

```bash
# 通过 source branch 查询 opened MR
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests?source_branch=<branch>&state=opened" \
  | python3 -c "import sys,json; mrs=json.load(sys.stdin); print(mrs[0]['iid'] if mrs else '')"
```

**2. 获取 MR 变更文件列表**（用于校验 inline path 合法性）：

```bash
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/changes" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(c['new_path'] for c in d.get('changes',[])))"
```

**3. 发布 Inline Findings**（逐条,使用 MR discussions API 创建 diff note）：

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/discussions" \
  -d '{
    "body": "<formatted_comment>",
    "position": {
      "position_type": "text",
      "base_sha": "<merge_base_sha>",
      "head_sha": "<head_sha>",
      "start_sha": "<merge_base_sha>",
      "new_path": "<file_path>",
      "new_line": <line_number>
    }
  }'
```

注意：
- `base_sha` / `start_sha` = MR 的 merge base commit（从 MR changes API 的 `diff_refs.base_sha` 获取）
- `head_sha` = MR 的 head commit（从 MR changes API 的 `diff_refs.head_sha` 获取）
- 若 inline 评论返回 400（行号不在 diff 范围），降级为全局评论并标注文件和行号

**4. 发布 Summary Comment**（全局 note）：

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/notes" \
  -d '{"body": "<summary_content>"}'
```

**5. 记录发布结果**：同通道 1。

### 通道 3：手动输出（兜底）

当 MCP 和 API token 均不可用时：

1. 将完整的 `platform-summary.md` 内容输出到聊天中，用户可手动粘贴到 CR。
2. 将各 inline findings 格式化输出（含文件路径和行号），用户可逐条复制。
3. 在 `publish-result.json` 中标记所有条目 `status: "manual_pending"`。
4. 输出提示：建议用户配置 `GITLAB_TOKEN` 环境变量或 `~/.gitlab-token` 文件以启用自动发布。

### GitLab Token 配置说明（供用户参考）

生成 Personal Access Token：
1. 访问 `https://gitlab.alibaba-inc.com/-/profile/personal_access_tokens`
2. 创建 token，勾选 `api` scope
3. 保存到以下任一位置：
   - 环境变量：`export GITLAB_TOKEN="glpat-xxxx"`（加入 `.zshrc` / `.bashrc`）
   - 文件：`echo "glpat-xxxx" > ~/.gitlab-token && chmod 600 ~/.gitlab-token`

---

## 3. 发布结果落盘

无论成功或失败，必须在评审目录生成以下文件：

- `code-review/<target>/platform-summary.md`：实际发布的摘要内容（可用于重试）。
- `code-review/<target>/publish-result.json`：发布结果记录，schema：
  ```json
  {
    "platform": "github|gitlab",
    "target_id": "<pr-number 或 mr-id>",
    "published_at": "<ISO timestamp>",
    "summary_comment": {
      "status": "success|failed",
      "error": "<失败原因，成功时为 null>"
    },
    "inline_comments": [
      {
        "path": "<file>",
        "line": <line>,
        "severity": "<severity>",
        "status": "success|failed",
        "error": "<失败原因>"
      }
    ],
    "comment_replies": [
      {
        "comment_id": "<id>",
        "action": "replied|resolved",
        "status": "success|failed"
      }
    ],
    "merge_gate": {
      "verdict": "APPROVE-READY|BLOCK",
      "approved": true,
      "blocking": []
    },
    "stats": {
      "total_findings": 0,
      "published": 0,
      "failed": 0
    }
  }
  ```

---

## 4. 失败处理与重试

- 若单条 inline 评论发布失败，继续发布其余评论，不中断流程。
- 所有失败条目记录到 `publish-result.json`，并在 `final-report.md` 的 "Platform Publish" 小节说明失败原因。
- **通道降级**：若当前通道（MCP）在发布过程中出错（如连接中断），自动切换到下一通道（API/手动）继续发布剩余条目。
- 提供重试命令提示，例如：
  - GitHub: `gh pr comment <pr> --body-file code-review/<target>/platform-summary.md`
  - GitLab MCP: 说明 `mcp__code__comment_merge_request` 调用参数
  - GitLab API: 给出完整 `curl` 命令（含 token 占位符）
- 若整体发布失败（如认证过期、MCP 不可用、无 token），自动降级到通道 3（手动输出），在聊天中输出完整的发布内容供用户手动粘贴。

---

## 5. 历史评论回复与关闭 —— 平台动作

回复内容格式、关闭规则、幂等策略见 `SKILL.md` 6.5；此处仅列各平台的具体调用方式。

- **GitLab MCP**：回复用 `mcp__code__comment_merge_request`（传 `parentNoteId=<comment_id>`）；关闭用 `mcp__code__update_merge_request_comment_status`（`noteId=<comment_id>`, `closed=1`）。
- **GitLab API**：回复用 `POST .../merge_requests/<iid>/discussions/<discussion_id>/notes`；关闭用 `PUT .../merge_requests/<iid>/discussions/<discussion_id>?resolved=true`。
- **GitHub**：回复用 `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies -f body=...`；关闭用 GraphQL `resolveReviewThread`。

每条回复 / 关闭结果写入 `publish-result.json` 的 `comment_replies` 字段（含 `comment_id`、`action: replied|resolved`、`status: success|failed`）。

---

## 6. 合入门禁 Approve / Block —— 平台动作

裁决逻辑（open 阻断项判定、APPROVE-READY / BLOCK）见 `SKILL.md` 6.6；此处仅列各平台动作。

**裁决 = APPROVE-READY → approve（通过）本 CR / PR：**

- GitLab MCP：`mcp__code__accept_merge_request`（`repo`, `mergeRequestId`）。
- GitLab API：`POST .../merge_requests/<iid>/approve`。
- GitHub：`gh pr review <pr> --approve`。
- approve 后在 summary 评论追加一行：`✅ Medium/High 及以上问题已全部解决，本轮评审通过（approved）。`

**裁决 = BLOCK：**

- **禁止** approve；在 summary 中列出阻断清单（severity + 文件:行号 + 现状），写明「阻断合入，待修复后重评」。

裁决结果写入 `publish-result.json` 的 `merge_gate` 字段：`{ "verdict": "APPROVE-READY|BLOCK", "approved": true|false, "blocking": [ ... ] }`。

注意：approve 仅表示本评审 agent 视角「无阻断问题」；是否真正 merge 仍受平台门禁（人工评审人数、CI 通过等）约束，本 skill **不主动执行 merge**。
