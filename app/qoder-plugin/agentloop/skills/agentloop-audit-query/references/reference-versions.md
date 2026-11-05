# 参考来源与版本

目录：`agentloop-audit-core`，修订 `1`。来源为 AgentLoop 行为、Token、风险、意图、拦截和实体调查核心视图；字段契约见 [schema](schema.md)。无公开产品版本时不虚构版本号。

| 参考 SQL | 口径修订 |
|---|---|
| 行为分析 | behavior-events.v1 |
| 模型响应 Token | response-usage.v1 |
| 调用归并 Token | call-usage.v1 |
| 风险记录 / 风险对象 | incident-record.v1 / incident-identity.v1 |
| 用户风险 | user-risk.v1 |
| 意图审计 | intent-labels.v1 |
| 拦截记录 | guardrail-block.v1 |
| 实体调查 | entity-occurrence.v1 |

计数对象、分母、来源或归并规则变化时递增口径修订；名称调整不改变口径版本。客户目标和执行结果保存在本地交付资料中，内部源码定位不随公开参考发布。
