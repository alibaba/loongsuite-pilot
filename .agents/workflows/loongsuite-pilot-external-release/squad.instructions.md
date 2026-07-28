# 小队目标

协调 LoongSuite Pilot external（商业版）的候选分析、0% 灰度、逐档观察、promote、Release Note 和 GitHub 下游发布。internal（集团版）不属于本小队流程。

当前工作流版本为 `1.0.0-validation`，只允许 `VALIDATION_MODE=true`。不得执行真实发布、线上通知或 Multica 写操作。

# 成员边界

- Pilot 发布协调 Agent：唯一编排者；维护工作流阶段、消费报告、验证人工门禁和生成模拟通知。
- Pilot 发布说明 Agent：独占 Change 分析和 promote 后的公开 Release Note。
- Pilot 发布执行 Agent：独占 external 发布 plan 与执行事实；不得决定下一步。
- Pilot 灰度观察 Agent：独占只读观察和风险证据；不得推进、暂停或回退发布。
- 人工：唯一批准者。

成员自己 Instructions 是角色边界的权威来源；本文件只定义协作顺序。

# 固定顺序

```text
CANDIDATE_CHECK
→ CHANGE_ANALYSIS
→ AWAIT_HUMAN_RELEASE_DECISION
→ APPROVED_TO_PLAN
→ AWAIT_EXTERNAL_START_CONFIRMATION
→ EXTERNAL_0
→ OBSERVE_0
→ EXTERNAL_5
→ OBSERVE_5
→ EXTERNAL_15
→ OBSERVE_15
→ EXTERNAL_40
→ OBSERVE_40
→ EXTERNAL_60
→ OBSERVE_60
→ PROMOTE
→ RELEASE_NOTE_PREPARING
→ AWAIT_GITHUB_RELEASE_CONFIRMATION
→ GITHUB_RELEASING
→ RELEASE_COMPLETED
```

禁止跳档和 `rollout 100`。每档至少观察 30 分钟，每次推进都需要一条绑定最新证据的人工明确评论。

# 风险

观察 Agent 报告风险时，协调 Agent 只提供证据并通知人工，进入 `AWAIT_HUMAN_ROLLOUT_DECISION`。不得自行设置 `PAUSED`、执行 `rollout 0`、hotfix、rollback 或继续扩灰。

# 状态

工作流事实写入父 Issue metadata：

- `workflow_version`
- `validation_mode`
- `release_target`
- `release_phase`
- `release_stage`
- `release_target_version`
- `release_pending_action`
- `release_consumed_event_ids`
- `release_last_consumed_child_id`
- `release_last_approval_comment_id`
- `release_notification_keys`
- `release_pause_reason`

Issue 标题只用于展示，不得作为脚本事实来源。

# 验证模式

验证模式只读取 fixtures 和已有只读数据，输出 `VALIDATION_RESULT`：

- 不创建或更新 Issue、metadata、评论和子任务。
- 不调用钉钉、Webhook、OSS 或 GitHub 写接口。
- 不执行 release、rollout、promote、hotfix 或 rollback。
- 不发送真实通知。
- 所有动作都使用 `WOULD_*` 或校验器的模拟结果表达。
