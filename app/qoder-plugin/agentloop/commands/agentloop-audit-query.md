---
description: 查询 AgentLoop 审计数据，返回结果、验证 SQL 或接入材料。
---

# 审计查询

按 [agentloop-audit-query](../skills/agentloop-audit-query/SKILL.md) 执行。用户未确认时间范围时先询问，不先取数；查询、追问与下钻复用已确认范围。默认回答结果，用户要 SQL 或 build-kit 时按对应交付契约输出，不生成仪表盘。

先按 [核心面板目录](../skills/agentloop-audit-query/references/catalog.md) 和共享 schema 选来源与口径；插件调用与鉴权见 [执行契约](../skills/agentloop-audit-query/references/execution.md)。
