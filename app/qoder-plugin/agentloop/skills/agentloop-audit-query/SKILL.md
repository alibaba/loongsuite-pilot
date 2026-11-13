---
name: agentloop-audit-query
description: 查询 AgentLoop 行为、Token、风险、意图、拦截和实体数据；按用户需求返回实际结果、验证 SQL 或 CLI/SDK 接入材料。仪表盘制作使用 agentloop-audit-dashboard。
---

# AgentLoop 审计查询

默认回答查询结果；用户要 SQL 时给完整可执行查询，要接入包时给模板、参数/结果契约与调用示例。

查询执行依赖 [Setup](../agentloop-collector-setup/SKILL.md) 的共享 CLI、认证与目标绑定。用户仅要登录、切账户或切换查询目标时，先按 Setup 的[账户与查询目标切换](../agentloop-collector-setup/references/auth.md)处理，不要求日志时间或执行查询；目标就绪后再继续查询任务。

## 工作流程

1. 确认时间与目标。缺少已确认时间时先询问，不先查数；追问沿用原范围，空结果不自动扩大时间。
2. 从 [查询目录](references/catalog.md) 选择参考 SQL，字段和业务口径查 [schema](references/schema.md)，展示标签查 [枚举](references/value-labels.md)。按需求添加筛选与分组。
3. 适配目标表与索引并执行验证。新写或修改的 SQL 超过一天时，先在目标范围内窄窗验证，再查询完整范围；比较窗口需要额外历史范围时先说明。
4. 检查完成状态，交付结果或 SQL，说明范围、口径及验证状态。无法执行时标明未执行；敏感内容只展示必要的脱敏摘要。需保存 SQL、结果或接入包时，默认放当前项目的 `output/audit/reports/`，用户指定目录时按其要求。

## 参考资料

| 资料 | 用途 |
|---|---|
| [查询目录](references/catalog.md) | 八类核心面板与参考 SQL 索引 |
| [schema](references/schema.md) | 数据模型、统计口径、公共构件与组织、账单外表关联 |
| [SQL 写作技巧](references/sql-writing.md) | JSON、关联、时间窗口、分页与汇总的 SLS 注意事项 |
| [执行说明](references/execution.md) | Skill 脚本、环境绑定与错误处理 |
| [接入交付](references/delivery.md) | SQL / CLI / SDK 参数与结果契约 |

需要仪表盘或 HTML 预览时使用 [agentloop-audit-dashboard](../agentloop-audit-dashboard/SKILL.md)；控件与点击跳转见 Builder 的 [筛选器](../sls-dashboard-builder/references/filters-and-variables.md) 和 [交互事件](../sls-dashboard-builder/references/drill-down-events.md)。
