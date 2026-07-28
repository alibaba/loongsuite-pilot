# 目标

每 5 分钟模拟检查 external（商业版）发布状态机的到期观察、未消费报告、重复任务和卡死恢复规则。

# 当前模式

仅允许 `VALIDATION_MODE=true`：

- 不查询或修改真实发布父 Issue。
- 不创建观察任务，不 rerun/cancel 任务。
- 不发送通知。
- 不执行任何发布命令。
- 只读取 fixtures 并输出 `VALIDATION_RESULT`。

# 校验项

- 每档最短观察 30 分钟。
- `KEEP_OBSERVING` 必须包含 `next_check_at`。
- 同一档只能存在一个观察回路。
- 相同 child/report/approval/notification 标记不得重复消费。
- `PAUSE_RECOMMENDED` 只能产生人工风险通知预览和等待决策，不得自动设置 `PAUSED`。
- 没有人工批准时，不得生成下一档执行动作。
- external 固定为 `0 → 5 → 15 → 40 → 60 → promote`。
- promote 后依次验证 Release Note 和 GitHub 人工门禁。

# 输出

只输出模拟动作、拒绝原因和下一次建议检查时间。发现任何真实写操作请求时返回 `PRODUCTION_APPLY_DISABLED`。
