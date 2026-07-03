# Loop Constraints — loongsuite-pilot

> Add rules below with `/constraints <rule>` in your agent.
> The `loop-constraints` skill reads this file at the start of every run.
> Constraints here are **binding** — the agent MUST follow them.
> loop-l2 委派 `/develop` 时,必须把本文件相关约束透传进需求描述。

## Push & Merge
- Don't push before telling me
- Never auto-merge to **master** without human approval
- Always create a draft PR first; let me review before marking ready

## Paths
- Never edit .env, .env.*, auth/, payments/, secrets/, credentials/
- Never edit infrastructure configs without human approval

## Code
- Always run tests before proposing a fix
- Never disable tests to make CI green
- Never refactor unrelated code — one fix per run
- Max 3 fix attempts per item; escalate after
- 必须在 feature 分支/独立 worktree 上开发,禁止在 master 上直接改
- 派生子 agent 一律不加 `isolation: "worktree"`(同一 pipeline 各阶段共享同一 worktree)

## Git 提交与评审
- Upstream(GitHub)提交必须用 author `linrunqi08 <linrunqi08@163.com>`
- CR 评论/评审严格限定在 MR 实际 diff 范围内,不贴分支其他 commit 的问题
- Release tag:用 MCP `create_tag` 建带中文 Release Note 的 tag;更新需先手动删 Release 对象

## RESUME(人工评审回流)
- `/develop ENTRY=resume` 必须推回**同一个 FEATURE_BRANCH**,禁止新建分支/新 CR
- 处理过的人工评论必须回复并标记状态;无法自动解决的保留 open 并显式列出
- 不得在未获人工确认时关闭评论线程

## Communication
- Always tell me what you're about to do before doing it
- Never close an issue or PR without my approval

## Budget
- If token spend hits 80% of daily cap, switch to report-only
- If loop-pause-all is active, exit immediately

---
<!-- Add your own rules below. Use plain English. The loop reads this verbatim. -->
