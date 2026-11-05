# 核心面板查询目录

按公开业务名称查找配方；每行代表一个可复用的查询视角，同一行的多个指标可由一条查询返回。配方是生成完整 SQL 的参考，执行前仍需绑定目标环境并验证。核心目录覆盖以下八类，不包含需要内部分析服务的优化建议、轨迹挖掘或评分面板。

## 来源与口径修订

- 目录标识：`agentloop-audit-core`；目录修订：`1`。
- 来源：AgentLoop 的审计事实、风险审计和实体调查核心视图；数据契约以 [schema](schema.md) 和各配方的字段前提为准。未提供公开产品版本时不虚构版本号。
- `response-usage.v1`：模型响应事件的已观测用量，保留原报表口径。
- `call-usage.v1`：带用量事件按来源、用户、应用、会话、Turn、Step、调用和模型归并，供内置 Token 视图参考；不能与响应事件求和口径混称。
- `incident-record.v1`：风险记录数；`incident-identity.v1`：按 incident_event_id 计风险对象；`entity-occurrence.v1`：按事实展开实体，再按稳定 ID 统计。配方中显式选择，不能互换。
- 参考 SQL 不附客户目标、真实结果或永久的“已验证”标签。交付时记录条目标识、口径修订、范围、参数、实际验证状态和结果完整性。

计数对象、分母、来源范围、归并或关联规则变化时递增对应口径修订，并复核使用该口径的条目。UI 标题变化只更新名称和检索别名。内部源码映射不随公开包发布。

## 行为分析

读取 [行为配方](queries/behavior.md)，应用事实需要两张应用表；运行时范围另行确认字段与来源适配，不能把应用模型与工具分类套到进程事件。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| behavior.summary | 活跃 Agent、会话数、模型请求、工具调用、命令执行、外部交互、工具错误 | 行为事件汇总；Agent 实例与 Agent 类型分别命名 |
| behavior.trend | 请求与行动趋势、Agent 类型行为趋势 | 时间桶 × 可选 Agent；总行为量只含模型请求/响应、工具调用/结果 |
| behavior.structure | 行为结构、工具/模型/命令/文件/网络构成、工具结果长度 | 对应事实粒度分组；工具名归一与命令识别规则显式说明 |
| behavior.errors | 工具错误率排名 | 工具 × 错误分子/调用分母；缺少可关联结果时披露覆盖 |
| behavior.turn-actions | Turn 编辑效率分布 | Turn 内修改与命令次数分桶，是观测动作量，不直接证明业务效率 |
| behavior.hourly | 24h Turn 活跃度 | 时区内 0–23 小时，不等同连续 24 小时趋势 |
| behavior.duration | Session 时长分布 | 窗口内首尾观测时间差，非完整生命周期 |
| behavior.sessions | 高活跃 Session | 身份复合键、交互量、工具/错误/命令数、最近时间 |

## Token 分析

读取 [Token 配方](queries/tokens.md)。与内置视图对账选择 `call-usage.v1` 并对齐来源；自建报表默认 `response-usage.v1`。样本分位数与全量分位数分别命名。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| token.summary | 总/输入/输出 Token、相关会话、P95 Session | 总量、会话与分位；UI 的 Top Session 样本 P95 不冒充全量 |
| token.trend | 周期同比趋势、最近 24 小时趋势、Agent 类型/模型 Token 趋势 | 时间桶 × 来源/Agent/模型；比较与固定 24h 窗口独立绑定 |
| token.averages | 平均 Turn / Session Token 趋势 | 先聚合 Turn/Session，再按其末次观测桶统计；非响应均值 |
| token.distribution | 单 Turn / Session Token 消耗分布 | 先聚合，再按固定阈值分桶 |
| token.long-sessions | 长对话分布 | 按 Turn 数分桶，平均时长和 Token、P95 |
| token.concentration | 消耗集中度 | 全范围 Session 排名、分层及总量分母，不能只用 TopN 算分母 |
| token.models | 模型分布 | 模型 × 总/输入/输出 Token、调用/会话数 |
| token.sessions | Session 消耗排名 | 会话复合键、总量、Turn/Step 数与窗口内时长 |
| token.steps | Turn / Step Token 明细 | 来源 × 会话 × Turn × Step × 模型 |

## 风险概览

读取 [风险配方](queries/risks.md)，仅高保真 `incident-event`。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| risk.overview | 高危风险数与占比 | critical/high 分子 / 同范围有效风险类型分母 |
| risk.distribution | 高危风险分布、子类分布 | risk_type × risk_subtype，风险对象去重 |
| risk.trend | 日/周对比趋势 | 当前与比较窗口分别聚合、对齐桶；零分母不构造增长率 |
| risk.worsening | 恶化最快风险 | 类型/子类的当前、前日、前周量与增长；产品评分规则需显式保持 |
| risk.impact | 影响面最大风险 | 类型/子类 × 应用、Agent、用户、主机、会话影响；按定义排序 |

## 风险浏览

读取 [风险配方](queries/risks.md) 中风险与检测发现的区别。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| risk.browser-summary | 风险总数、严重及高危、影响 Session、风险类型数 | 按当前风险来源与筛选，不能与检测发现量混合 |
| risk.browser-trend | 全部风险与高危时间分布 | 同一筛选的时间桶计数 |
| risk.browser-facets | 类型/子类、严重性、检测标识、应用/用户/Agent 筛选分布 | 原始值与数量；类型/子类保持父子配对 |
| risk.browser-records | 风险事件、检测发现明细 | 两种对象分别分页，保留原始来源、标识和证据引用 |

## 用户风险

读取 [用户风险配方](queries/users.md)。只按平铺 user 统计的结果是身份字段视角；与 UI 实体归一用户清单对账时要先核对实体用户 ID 映射。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| user.ranking | 用户风险排行 | 用户 × 高危/全部风险、会话、最近时间 |
| user.overview | 用户概览 | 单用户风险、会话、主机、应用与最近风险 |
| user.time | 风险时段分布 | 单用户 × 时间桶，含严重性维度 |
| user.composition | 风险构成 | 用户 × 类型/子类、严重性数量与占比 |
| user.entities | 相关实体 | 单用户关联风险的稳定实体 ID、类型、数量与证据 |
| user.incidents | 具体风险 | 单用户筛选的 incident 分页明细 |

## 意图审计

读取 [意图配方](queries/intents.md)，限定普通/自定义意图事件。若对账页面还限定检测器，要在同一过滤下验证；自定义意图不能直接套默认分类标签。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| intent.summary | 识别意图数、风险意图数及占比 | 意图记录、普通/风险域分子分母；不是风险 incident 数 |
| intent.trend | 意图活动趋势 | 时间桶 × 普通/风险意图 |
| intent.categories | 意图分布、用户维度意图分布 | 分类/子类 × 去重会话或用户，说明多标签不可相加 |
| intent.tokens | Token 消耗分布 | usage_total_tokens 为意图分摊量，不含模型维度 |
| intent.risks | 风险意图分布与明细 | 风险类型/子类及识别证据，不等同已确认风险 |
| intent.users | 用户概览、最近活动 | 用户 × 意图/会话/分类与最近时间 |
| intent.sessions | 会话概览、意图明细 | 身份复合键 × 意图标签及可用分摊用量 |
| intent.model-usage | 意图 × 模型 × 平均 Session Token | 扩展组合：Session 用量预聚合后关联标签，披露关联覆盖 |

## 拦截记录

读取 [拦截配方](queries/interceptions.md)，依赖公开 guardrail 字段，不从 incident 或错误消息猜是否拦截。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| interception.summary | Guardrail 已触发、已拦截 | triggered=true；block 子集，两表分别计数后汇总 |
| interception.trend | 拦截时间分布 | block 事实 × 时间桶 |
| interception.facets | 应用、用户、Agent、工具、主机及事件筛选分布 | 原始事实字段和值 |
| interception.records | 拦截记录与详情 | 事件/Session/Tool Call/Trace 标识、发生时间与会话证据回溯 |

## 实体调查

读取 [实体配方](queries/entities.md)。有实体提取事实才可列清单；只有 incident 实体时结果命名为“风险关联实体”，不能冒充全体实体。

| 业务标识 | 面板 / 指标 | 粒度与返回内容 |
|---|---|---|
| entity.types | 实体类型概览 | 类型 × 稳定 ID 数、事实出现数、关联会话、最近时间 |
| entity.inventory | 实体清单 | 类型 + 稳定 ID、脱敏展示值、首次/末次时间与风险附着 |
| entity.profile | 实体画像、风险分布与时间线 | 焦点实体 × 关联风险，保持风险与事实计数分离 |
| entity.sessions | 出现会话 | 来源/用户/应用/Session 与证据事件；不跨来源仅凭 Session ID JOIN |
| entity.relations | 关系与证据回溯 | 同事件/同会话共现、明确调用/文件/外联证据边分别返回；不要求复刻图布局 |

## 外表扩展

部门/团队用量、覆盖率、零用量人群和业务归属遵循 [schema 的 dept_roster](schema.md#source-dept_roster外表关联示例)。花名册决定分母，先确认标识映射和快照有效期；没有真实表时使用明确标注的假设数据。外表 JOIN、本地分页和多条 SQL 均属于正常查询组合，不能因不止一条语句而排除。
