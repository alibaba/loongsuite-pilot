# 成员报告契约

## 协调校验快照

调用校验器前，把父 Issue metadata 归一化为：

```json
{
  "workflow_version": 1,
  "validation_mode": true,
  "target": "external",
  "target_version": "v1.1.20",
  "phase": "OBSERVING",
  "stage": "EXTERNAL_15",
  "latest_evidence_id": "observe-15",
  "change_child_id": "change-1",
  "observation_child_id": "observe-15",
  "observation_child_stage": "EXTERNAL_15",
  "consumed_event_ids": [],
  "notification_keys": [],
  "event": {}
}
```

`consumed_event_ids` 来自 `release_consumed_event_ids`，
`notification_keys` 来自 `release_notification_keys`。校验结果只是模拟动作；
验证模式不得把它写回父 Issue。

## Change 报告

必填字段：

```json
{
  "report_type": "change-report",
  "decision": "RELEASE",
  "recommended_bump": "patch",
  "previous_version": "v1.1.19",
  "suggested_version": "v1.1.20",
  "features": [],
  "bugfixes": [],
  "risks": [],
  "blockers": [],
  "no_release_reason": "",
  "evidence_url": "https://...",
  "notification_copy": {}
}
```

`decision` 只能是：

- `RELEASE`
- `NO_RELEASE`
- `NEED_HUMAN_REVIEW`

`NO_RELEASE` 和 `NEED_HUMAN_REVIEW` 必须提供 `no_release_reason`。

## 发布执行报告

发布执行 Agent 只报告事实，不决定流程下一步：

```json
{
  "report_type": "execution-report",
  "mode": "PLAN",
  "requested_action": "EXTERNAL_0",
  "outcome": "PLAN_READY",
  "target": "external",
  "target_version": "v1.1.20",
  "executed_stage": "",
  "plan_id": "comment-or-artifact-id",
  "evidence_url": "https://...",
  "error": ""
}
```

`outcome` 只能是：

- `PLAN_READY`
- `SUCCEEDED`
- `FAILED`
- `NOT_EXECUTED`

报告不得包含决定性的 `next_action`。下一步由协调状态机计算。

## 观察报告

```json
{
  "report_type": "observation-report",
  "target": "external",
  "target_version": "v1.1.20",
  "stable_version": "v1.1.19",
  "observed_stage": "EXTERNAL_15",
  "observe_since": "2026-07-28T10:00:00+08:00",
  "observe_until": "2026-07-28T10:30:00+08:00",
  "minimum_window_satisfied": true,
  "sample": {
    "target_active_instances": 0,
    "stable_active_instances": 0,
    "target_error_count": 0,
    "stable_error_count": 0
  },
  "summary": "",
  "risk_level": "LOW",
  "key_errors": [],
  "limitations": [],
  "evidence_url": "https://...",
  "recommendation": "CONTINUE_REVIEW_READY",
  "next_check_at": ""
}
```

`recommendation` 只能是：

- `CONTINUE_REVIEW_READY`
- `PAUSE_RECOMMENDED`
- `KEEP_OBSERVING`

`KEEP_OBSERVING` 必须提供 `next_check_at`。风险结论只供人工决策，不能授权回退、暂停或继续。

## Release Note 报告

```json
{
  "report_type": "release-note-report",
  "target": "external",
  "target_version": "v1.1.20",
  "summary": "",
  "features": [],
  "bugfixes": [],
  "evidence_url": "https://..."
}
```

所有公开内容必须脱敏。
