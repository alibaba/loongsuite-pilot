# 增量评审细则（Phase 1 参考）

本文件收纳 Phase 1 的**增量映射与状态文件细则**（字段约束、L1/L2/L3 映射策略、snapshot 职责）。
执行步骤序列与决策留在 `SKILL.md` Phase 1，本文件只被按需加载。

---

## 状态文件字段约束（必须遵守）

- `reviewed_commits.json` 记录：
  - `commit_sha`
  - `patch_id`（用于 rebase 后精确映射）
  - `review_round`
  - `reviewed_at`
  - `hunk_fingerprints`（数组）
- `comments/comment-status.json` 记录：
  - `comment_id`
  - `path` / `line` / `side`
  - `body`
  - `snippet`（可读代码片段）
  - `snippet_fingerprint`（规范化片段 hash）
  - `status_flow`（`open|resolved|wont-fix|deferred`）
  - `status_tech`（`fixed|not-fixed|false-positive|partially-fixed`）
  - `mapped_finding_id`

说明：

- `snippet_fingerprint` 定义为“规范化代码片段 + 文件路径 + 评论定位三元组（line/side/comment_id）”的稳定 hash，不能只用行号。
- 允许人工修正 `status_flow` 与 `status_tech`，但不得删除历史记录。

---

## 增量评审策略（必须执行）

1. 优先读取 `reviewed_commits.json`，只评审未覆盖的新变更。
2. 若检测到 rebase/force-push，不可直接判定全量重审，先做映射再决策：
   - L1（高置信）：按 `patch-id` 映射旧 commit -> 新 commit，命中后继承“已评审”状态。
   - L2（中置信）：按 `path + 规范化 hunk 片段 + hunk 上下文` 做指纹匹配，仅补审未命中 hunk。
   - L3（低置信）：命中率低或冲突改写明显时，回退全量评审。
3. 置信度门槛默认：
   - `commit_map_rate >= 90%`：增量通过
   - `hunk_match_rate >= 80%`：局部补审
   - 否则全量回退
4. 即使全量回退，也必须复用历史评论与 finding 去重，避免重复意见。

---

## snapshot 在增量决策中的职责（必须遵守）

1. `snapshot` 是增量决策辅助依据，不替代 git 主链路（`patch-id`/`hunk`）。
2. rebase 且发生冲突改写时，若 commit/hunk 映射不足，可使用 `snapshot_match_rate` 辅助从 `full` 降到 `partial`。
3. squash 合并导致 commit 边界丢失时，`snapshot_match_rate` 用于判断是否可继续增量评审。
4. 若 `snapshot_match_rate` 不足阈值，仍必须 `full` 全量评审。
