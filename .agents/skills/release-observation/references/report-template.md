# 观察报告模板

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

规则：

- `target` 必须为 `external`。
- `observed_stage` 只能是 `EXTERNAL_0`、`EXTERNAL_5`、`EXTERNAL_15`、`EXTERNAL_40`、`EXTERNAL_60`。
- `minimum_window_satisfied=false` 时只能返回 `KEEP_OBSERVING`。
- `KEEP_OBSERVING` 必须提供 `next_check_at`。
- `PAUSE_RECOMMENDED` 只表示建议人工介入，不表示已经暂停。
- `DATA_UNAVAILABLE` 使用相同结构，并在 `limitations` 中说明缺失证据。
