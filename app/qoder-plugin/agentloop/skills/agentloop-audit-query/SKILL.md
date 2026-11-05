---
name: agentloop-audit-query
description: 查询 AgentLoop 审计数据，回答行为、Token、意图、风险、拦截与实体调查问题；按用户需求返回实际结果、经验证的 SLS 查询 SQL 或 CLI/SDK 接入材料。制作仪表盘时使用 agentloop-audit-dashboard。
---

# AgentLoop 审计查询

将业务问题转换为 SLS 检索或 SQL，选择正确数据源、适配客户环境、执行验证，并按用户意图交付。默认回答结果；用户要 SQL 或 build-kit 时交付可复用查询及调用契约，不默认生成报表。

## 时间与范围

- 用户未给出且上下文未确认时间范围时，先询问，不能先执行日志或统计探测，也不默认最近一小时或七天。
- 筛选、追问和下钻沿用已确认范围。明确时区和 Unix 秒起止时间；不因空结果自动扩到更长时间。
- 新写或改写的 SQL 目标范围超过一天时，先在目标范围内选窄窗验证字段、语法、关联与结果结构，通过后再查完整范围。窄窗为空不能推断完整范围为空；超过一天的完整扫描不能作为语法试错。
- 查询接口时间覆盖 SQL 的所有来源与比较窗口。同比需要额外历史区间，先说明该区间；不把预检或比较窗口冒充用户目标范围。

## 工作流

1. 确认用户需要结果、SQL、接入包或仪表盘，以及时间、目标和必要筛选。复用上下文，不要求用户重复提供 Skill 路径或 SQL 细节。
2. 按 [核心面板目录](references/catalog.md) 选择业务口径，再按 [数据源](references/capabilities.md)、[共享 schema](references/schema.md) 选择表、字段、清洗和关联构件。只读取对应主题的查询参考。
3. 绑定实际 Project、Region、可用表、索引和权限。确认引用字段存在且已启用统计，不能用 COALESCE 引用不存在列；缺少统计能力时说明前提，不擅自改成全量扫描。缺表不等于 0；外表先确认身份映射、唯一归属与有效期。客户环境只保存在本地，不写回公开参考。
4. 按 [执行契约](references/execution.md) 展开和安全转义参数，运行适当的验证与完整范围查询；检查完成状态、行数/分页、结果字段和聚合粒度。查询失败时修复必要条件，不用另一种计数对象代替。
5. 按下表交付。报告实测范围与验证边界；用户只要 SQL 时仍应验证，权限或环境不允许时明确标记“未执行”。

| 用户需求 | 交付内容 |
|---|---|
| 查询、排名、趋势、调查 | 实际结果与简短解读，时间/范围、计数对象和完整性；不默认附长篇 SQL |
| 查询 SQL | 可直接粘贴的完整 `检索 | SQL`、承载 Logstore、时间与参数、输出字段、验证状态；不是只有 SELECT 尾部或 CTE 片段 |
| build-kit / SDK 封装 | SQL/模板、参数类型与默认行为、结果契约、指定语言或 CLI 的调用示例，以及分页/完成状态/错误处理；读 [接入交付](references/delivery.md) |
| 报表、大盘、HTML 预览 | 转入 [agentloop-audit-dashboard](../agentloop-audit-dashboard/SKILL.md)，复用这里的查询知识 |

## 查询参考

- [schema.md](references/schema.md)：应用两表合并、模型响应 Token、有效缓存样本、意图/风险、组织外表、公共 SQL 原子与 CTE。新增业务语义维护在此。
- [catalog.md](references/catalog.md)：八类核心面板、口径修订、使用前提与查询配方；目录条目不代表已在客户环境验证。
- [value-labels.md](references/value-labels.md)：展示标签与原始筛选编码。
- [execution.md](references/execution.md)：环境、调用、转义、分页、完整性与鉴权失败处理。
- [delivery.md](references/delivery.md)：SQL 和 build-kit 的参数/结果契约及验证标记。
- [plugin-usage.md](references/plugin-usage.md)：对话筛选与下钻。普通查询不需要安装 Builder；仪表盘控件和点击事件由 Dashboard / Builder 提供。

## 口径与证据

- 应用事实读取 `agent-event` 与 `agent-event-webtracking`，兼容历史事件名。正常事件 ID 唯一，不为特殊回流额外加入事件去重。
- 模型响应的已观测 Token 与产品调用归并 Token 是不同口径；对账先确认来源、过滤、粒度与版本，不能默默替换算法。Token 不是账单。
- `audit-event` 中意图、安全发现、Skill 上下文分开；高保真风险来自 `incident-event`。意图与风险分别使用限定事件名和数据域，不能整表 count 冒充意图。
- 会话关联保留来源、用户、应用等身份上下文；先预聚合再关联多标签/风险/组织，防止用量放大。共现关系不等于因果或已执行操作。
- 默认不输出原文、完整凭据或敏感实体值。风险摘要可以展示已脱敏证据，但不能用命中值替代或编造判定原因；未记录的原因应如实说明。
- 验证状态区分“本轮目标实测”“参考环境实测”“离线验证”“未执行”。一次参考环境成功不证明所有客户、索引或版本可用。
