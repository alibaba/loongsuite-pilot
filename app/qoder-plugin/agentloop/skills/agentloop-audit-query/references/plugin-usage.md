# 对话筛选与下钻

业务口径与来源见 [目录](catalog.md) 和 [schema](schema.md)。普通查询仅需要 [执行契约](execution.md)，不依赖报表控件。

## 筛选契约

- 用户说“全部”时省略该业务谓词；精确选择使用结果中的原值。标签只用于展示。
- 模板中的 `__all__` 仅在模板明确采用该哨兵值时表示全部，空串不自动代表全部。CLI/SDK 调用前展开所有 `${{ }}`。
- 应用表用 `"user.id"` / `"gen_ai.agent.type"`，审计/风险表用 `"user"` / `agent_type`。跨表先按 schema 映射，不复用错误列名。
- 从汇总到会话、风险、实体，保持已确认 Project、Region、时间、来源与筛选。点击/追问的新条件追加到原范围，不悄悄重置时间。
- Session ID 不能替代完整身份键；风险回捞使用 evidence_session_id / evidence_event_ids，实体使用稳定 ID 与类型，不把展示名当唯一键。

例如“最近 7 天各 Agent 的 Token”先选应用模型响应口径，生成两表合并查询；先窄窗验证，再查完整七天。接着“看其中 qoder 的会话”沿用同一范围和来源，按结果的 `agent_type='qoder'` 收窄，再以用户/应用/Session 复合键聚合。

用户明确要控制台链接或交互式报表时，再读 Builder 的 [筛选器与变量](../../sls-dashboard-builder/references/filters-and-variables.md) 与 [交互事件](../../sls-dashboard-builder/references/drill-down-events.md)。纯 SLS 使用原生跳转；AgentLoop 当前按其中 URL 配方传递变量和时间。没有已存在的目标仪表盘名时不编造链接。
