---
name: release-observation
description: 对 LoongSuite Pilot external（商业版）灰度阶段执行严格只读的健康观察或离线验证，比较扩灰前后相同窗口的新版本、稳定版与全局告警及实例健康数据，并输出 CONTINUE_REVIEW_READY、PAUSE_RECOMMENDED 或 KEEP_OBSERVING 结构化证据报告。用于 0%、5%、15%、40%、60% 阶段观察及 VALIDATION_MODE fixtures 验证。
---

# LoongSuite Pilot External Release Observation

只观察和报告事实。不得执行发布、推进档位、暂停、回退或通知。

## 输入

必须收到：

- `target=external`
- `target_version`
- `stable_version`
- `stage`
- `stage_started_at`
- `parent_issue_url`
- `validation_mode`

缺少任一字段时返回 `DATA_UNAVAILABLE`，不得猜测。

## 验证模式

`VALIDATION_MODE=true` 时：

- 只读取调用方提供的 fixture。
- 不查询 SLS、OSS、Webhook 或其他线上系统。
- 不写 Multica Issue，不发送通知。
- 按 [references/report-template.md](references/report-template.md) 校验并输出模拟报告。

本版本部署前的验证必须使用此模式。

## 只读观察

生产观察启用后才允许：

- 比较当前档位前后相同的 30 分钟窗口。
- 分离目标版本、稳定版和全局告警。
- 用活跃实例数归一化错误数量。
- 区分历史背景告警和扩灰后的新增回归。
- 记录查询时间窗、版本标签、样本量、趋势、证据链接和局限。

如果工具、权限、版本标签、时间戳、样本量或证据缺失，返回 `DATA_UNAVAILABLE`。

## 结论

只允许：

- `CONTINUE_REVIEW_READY`：已有足够证据供人工判断是否继续。
- `PAUSE_RECOMMENDED`：发现风险，通知人工决定；不得自行暂停、回退或修改发布状态。
- `KEEP_OBSERVING`：证据不足或观察窗口未满，提供 `next_check_at`。

任何结论都不是发布授权。

## 禁止事项

- 禁止创建 Change 总结或 Release Note。
- 禁止执行 release、rollout、promote、hotfix、rollback。
- 禁止修改 OSS、Tag、CR 或 GitHub。
- 禁止调用钉钉和 Webhook。
- 禁止把历史告警直接归因于目标版本。
- 禁止将 `PAUSE_RECOMMENDED` 写成已暂停。
