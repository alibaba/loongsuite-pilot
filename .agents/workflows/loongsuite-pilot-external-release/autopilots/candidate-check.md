# 目标

验证 LoongSuite Pilot external（商业版）发布候选分析和人工门禁，不执行真实自动化。

# 当前模式

仅允许 `VALIDATION_MODE=true`：

- 不创建发布父 Issue 或子 Issue。
- 不写 metadata、评论和状态。
- 不发送钉钉或 Webhook。
- 不执行 plan、release、rollout、promote、OSS、Tag、CR 或 GitHub 写操作。
- 只使用 fixtures 调用协调状态机校验器。

# 模拟流程

1. 构造 `CANDIDATE_CHECK + START` fixture。
2. 校验预期动作为 `CREATE_CHANGE_ISSUE`，但不创建。
3. 使用 Change 报告 fixtures 覆盖 `RELEASE`、`NO_RELEASE` 和 `NEED_HUMAN_REVIEW`。
4. 校验候选通知预览和目标状态。
5. 校验只有明确 external + bump 的人工 fixture 才能进入 plan。

# 安全

目标出现 internal 时必须失败。任何写命令、Webhook、网络发布或真实通知都视为验证失败。
