# AI Agent Audit Schema

本 skill 的业务语义入口，覆盖应用事实、意图审计、风险事件、可选组织维表、指标口径和公共 CTE。报表 spec 通过 logical source 引用数据源。

字段契约中的值为原始编码。生成展示标签时，按需查阅 [value-labels.md](value-labels.md) 中对应字段的映射表；查询写法见本文“枚举展示与交互”。

## Data Source Bindings

- **Project / Region**：报表目标 Project 及其所属 Region。
- **CLI profile**：调用方指定的已配置 profile。
- **查询时间**：SLS 查询接口和各 chartQuery 使用相同时间窗口。
- **SQL 表名**：含连字符的 Logstore 名使用双引号包裹，例如 `"agent-event"`。

逻辑数据源（logical source）是报表 spec 在 `data.sources` 中引用的一类业务数据。Agent 根据这个名称选择实际数据表；例如 `agent_events` 对应下表中的两张应用事件表，查询时合并读取。

| 逻辑数据源（spec 引用名） | 实际表 / Logstore | 用途：能回答什么问题 | 查询时间 |
|---|---|---|---|
| `agent_events` | `agent-event` + `agent-event-webtracking` | 谁在使用 Agent、用了哪些模型和工具，以及 Token 消耗和缓存命中率如何。 | `__time__`，Unix 秒 |
| `intent_events` | `audit-event` | 用户希望 Agent 完成什么工作，普通需求与风险意图分别有哪些、各有多少。 | `__time__`，Unix 秒 |
| `incident_events` | `incident-event` | 发现了哪些风险、涉及哪些用户或会话、风险数量如何变化，以及证据在哪里。 | `__time__`，Unix 秒 |
| `dept_roster` | 客户提供，例如 `department` | 补充员工与团队归属；结合事件统计团队使用人数、覆盖率，以及在册但未产生日志的员工。 | 由客户确认快照有效期 |

读取说明：`agent_events` 合并两路字段契约相同的应用事实；`intent_events` 只读取 `audit-event` 中的意图事件，具体事件名见其字段说明。`dept_roster` 是可选的客户扩展，需要确认员工标识映射、组织归属和快照有效期。

`ebpf-event` 是独立的运行时观测来源，应用 Token 报表使用上述两张应用事实表。

## Source Composition

按要回答的问题选择数据源；跨来源关联的身份键、预聚合和统计口径见各 Source 章节。

| 想回答的问题 | 所需数据源 | 分析方式 |
|---|---|---|
| Agent 的使用规模和用量如何变化？ | `agent_events` | 统计活跃用户、模型与工具使用、Token 消耗、缓存命中率和时间趋势 |
| 不同用户意图对应多少 Token 消耗？ | `agent_events` + `intent_events` | 将意图标签关联到会话用量，再比较不同意图对应的已观测消耗 |
| 出现风险的用户或会话消耗了多少 Token？ | `agent_events` + `incident_events` | 分别汇总用量和风险，再关联查看；保留未匹配的数据和关联覆盖情况 |
| 各业务团队有多少人在用，哪些在册员工尚未产生日志？ | `agent_events` + `dept_roster` | 用花名册确定统计人群，再关联事件，计算团队使用人数、覆盖率和用量 |
| 如何按客户的项目或其他业务分类统计？ | 事实源 + 客户提供的外表 | 用客户映射表补充业务分类，按确认的归属关系统计 |

事件事实只能给出已观测用户及行为；在册员工、姓名、部门和业务归属由外表补充。外表关联能力独立于事实 schema，具体表名、关联键、唯一性及有效期在接入时绑定。报表名称、TopN、筛选项和布局放在场景 spec 中。

## Source: agent_events

每条记录对应一次 Agent 行为事件。模型调用、工具调用和会话行为通过 `event.name` 区分；`user.id` 表示发起请求的用户，具体标识形式由接入方式决定。

### 字段 Schema

SLS 元数据 `__time__` 为秒级过滤时间，`__source__`、`__tag__:*` 按实际索引访问；语义时间 `time_unix_nano` 为 int64 纳秒，不可把两者单位混用。下面的 string/int/json 是逻辑类型，SQL 能否分析仍需确认索引类型及统计开关。

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `event.id` | string | 事件唯一标识，全局唯一。 |
| `event.name` | string | 事件类型，表示该条记录描述的行为类别。取值见“事件名称与兼容名称”。 |
| `time_unix_nano` | int64 | 事件发生时间，单位为纳秒级 Unix 时间戳。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `__tag__:__hostname__` | string | SLS LogGroup 主机名元数据。`host.name` 为空或缺失时，用作主机名的兼容值。 |
| `__source__` | string | SLS 写入来源元数据。`host.ip` 为空或缺失时，用作 Agent 主机 IP 的兼容值；不表示网络对端或外联目标。 |
| `host.id` | string | 主机或执行环境的稳定标识。 |
| `host.name` | string | Agent 运行所在的主机、Pod、容器或执行环境名称。 |
| `host.ip` | string | Agent 运行所在主机的 IP 地址。审计结果表将该值平铺为 `source_ip`。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `user.id` | string | 发起请求的用户标识。 |
| `gen_ai.agent.type` | string | Agent 类型标识，例如 `qoder`、`cursor`、`claude-code`。 |
| `gen_ai.agent.id` | string | Agent 实例唯一标识。 |
| `gen_ai.agent.name` | string | Agent 实例的可读名称。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `gen_ai.session.id` | string | 会话唯一标识，对应一次完整的 Agent 对话或任务。 |
| `gen_ai.turn.id` | string | Turn 唯一标识，对应一次用户输入到 Agent 最终响应的完整交互。 |
| `gen_ai.turn.start` | boolean | 是否为 Turn 的起始事件。仅在值为 `true` 时写入。 |
| `gen_ai.turn.end` | boolean | 是否为 Turn 的结束事件。仅在值为 `true` 时写入。 |
| `gen_ai.step.id` | string | Step 唯一标识，对应一个 ReAct 循环（思考 → 动作 → 观察）。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `gen_ai.provider.name` | string | 模型服务提供方标识，例如 `anthropic`、`openai`、`qwen`、`deepseek`。 |
| `gen_ai.request.model` | string | 请求模型名称。 |
| `gen_ai.response.model` | string | 实际响应的模型名称，可能与请求模型不同。 |
| `gen_ai.response.id` | string | 模型响应的唯一标识，由模型服务返回。 |
| `gen_ai.response.finish_reasons` | string[] | 模型停止原因，常见取值包括 `stop`、`tool_calls`、`length`、`content_filter`、`error`。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `gen_ai.input.messages_delta` | json | 增量输入消息，记录自上次可重建输入以来新增的消息内容。是审计分析和 Session 浏览中使用的主要输入内容字段。 |
| `gen_ai.input.messages` | json | 发送给模型的完整消息历史。该字段可能包含敏感信息，按需启用采集。 |
| `gen_ai.output.messages` | json | 模型输出消息，包含角色、文本、工具调用和推理内容。 |
| `gen_ai.system_instructions` | json | 系统指令或开发者指令，与对话消息分离的提示词内容。 |
| `gen_ai.tool.definitions` | json | 模型请求时可用的工具定义列表。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `gen_ai.usage.input_tokens` | int | 输入 Token 数量（包含缓存读取）。 |
| `gen_ai.usage.output_tokens` | int | 输出 Token 数量。 |
| `gen_ai.usage.cache_read.input_tokens` | int | 从缓存中读取的输入 Token 数量，已包含在 `input_tokens` 中。 |
| `gen_ai.usage.cache_creation.input_tokens` | int | 写入缓存的输入 Token 数量，已包含在 `input_tokens` 中。 |
| `gen_ai.usage.total_tokens` | int | 总 Token 数量，等于 `input_tokens + output_tokens`。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `gen_ai.tool.name` | string | 工具名称，与模型调用中的 function/tool name 一致。 |
| `gen_ai.tool.call.id` | string | 工具调用标识，由模型生成，用于关联调用与结果。 |
| `gen_ai.tool.call.arguments` | json | 工具调用参数。该字段可能包含敏感信息。 |
| `gen_ai.tool.call.result` | json | 工具执行结果。该字段可能包含敏感信息。 |
| `gen_ai.tool.call.duration` | int | 工具执行耗时，单位为毫秒。 |
| `gen_ai.skill.name` | string | 工具加载的 Skill 名称（如适用）。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `error.type` | string | 错误类型标识，在操作发生错误时写入。无错误时该字段不存在。 |
| `error.message` | string | 错误详情的可读描述。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `trace_id` | string | W3C Trace ID（32 位十六进制），用于分布式链路关联。 |
| `span_id` | string | Span ID（16 位十六进制）。 |
| `parent_span_id` | string | 父 Span ID（16 位十六进制）。 |

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `__tag__:__service_name__` | string | Agent 应用或服务名称，用于按应用维度筛选和归因。 |
| `service.name` | string | 应用名称（备用），当 `__tag__:__service_name__` 缺失时作为补充。 |

### 事件名称与兼容名称

| 行为 | 标准事件名 | 兼容事件名 |
|---|---|---|
| 模型请求 | `gen_ai.model.request` | `llm.request` |
| 模型响应 | `gen_ai.model.response` | `llm.response` |
| 工具调用 | `gen_ai.tool.call` | `tool.call` |
| 工具结果 | `gen_ai.tool.result` | `tool.result` |
| 子 Agent 调用/结果 | `gen_ai.agent.invoke` / `gen_ai.agent.result` | — |

模型与工具统计同时匹配标准事件名和兼容事件名。其他名称（如 `agent.input`、`other`）保留原值，分别统计。

### 指标口径

- 应用事件数：两表合并后的记录数（不额外去重）。模型响应数：仅上述两种 response 事件名；不得把 request、response、tool 混作调用数。
- Token：在响应粒度统计输入、输出，`total = input + output`。`input_tokens` 已包含 cache read 和 cache creation，不再重复相加。缺失用量不是零；可用已采集字段求“已观测 Token”，同时给出完整用量响应数/覆盖率，不当成完整消耗或账单。
- 缓存命中率：有效配对样本上的 `sum(cache_read_tokens) / sum(input_tokens)`；有效条件为输入 > 0 且 0 ≤ 缓存读取 ≤ 输入。显式缓存 0 是未命中，字段缺失是未知；缺失、异常样本不进该比率分子分母，必须另报覆盖率与异常数。跨模型/Agent 汇总重新相除，不平均百分比。
- 用量一致性：`cache_read_tokens > input_tokens` 属于异常缓存样本，单独计数；总 Token 按输入与输出之和计算。
- Agent 维度使用 `gen_ai.agent.type`，未知单列；实例名称不等于类型。模型优先 `gen_ai.response.model`（实际响应），再用请求模型，最后 `unknown`。若看请求模型分布，应单独命名。
- 活跃用户按有效 `user.id` 去重；缺失用户只从用户 Top 中排除，不能从全量用量悄悄排除。Session/Turn 按用户及会话上下文计数，不把 Turn 当成已完成业务任务。
- Tool 次数只统计 call；`gen_ai.skill.name` 是可选字段，先查非空覆盖。可从已执行工具读取的 `file_path` 派生 Skill 名，但必须标成路径推断，核对工具及结果，不能仅凭模型消息中的调用意图认定已执行。
- 成本统计需要独立的账单或价格表，Token 用量本身不表示人民币、credits、节省金额或业务效率。使用 `gen_ai.usage.*_cost` 等扩展字段前，确认目标数据源的字段定义和采集覆盖。

### SQL 原子元素

按需求组合基础表达式、过滤条件和聚合，再选择是否使用公共 CTE 或外表。下面是局部构件，不要求每个图表复制完整 CTE。

#### 基础清洗表达式

以下投影直接作用于原始 Logstore 行。复制到已有 CTE 时，使用该层实际保留的列名；例如原始 `"user.id"` 先投影为 `user_id` 后，后续层对 `user_id` 清洗。不能在尚未产生别名的查询层引用它。

| 用途 | 原始行表达式 | 说明 |
|---|---|---|
| 用户标识 | `nullif(nullif("user.id", ''), 'null') AS user_id` | 清洗后 `user_id IS NOT NULL` 才是有效用户；全量行为/用量事实不能因此被过滤。 |
| Session 标识 | `nullif(nullif("gen_ai.session.id", ''), 'null') AS session_id` | 关联 Session 时仍须结合用户、来源等身份上下文。 |
| Agent 类型 | `coalesce(nullif(nullif("gen_ai.agent.type", ''), 'null'), 'unknown') AS agent_type` | 不用 Agent 实例名称替代类型。 |
| 供应商 | `coalesce(nullif(nullif("gen_ai.provider.name", ''), 'null'), 'unknown') AS provider` | 未知值保留为 `unknown`。 |
| 实际响应模型 | `coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'), nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model` | 按实际响应优先；请求模型分析应单独命名。 |
| 输入 Token | `try_cast("gen_ai.usage.input_tokens" AS bigint) AS input_tokens` | 转换失败或字段缺失仍是未知。 |
| 输出 Token | `try_cast("gen_ai.usage.output_tokens" AS bigint) AS output_tokens` | 缺失或转换失败仍是未知。 |
| 缓存读取 Token | `try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) AS cache_read_tokens` | 可缺失；只在缓存有效样本过滤通过时进入比率。 |
| 工具名称 | `nullif(nullif("gen_ai.tool.name", ''), 'null') AS tool_name` | 只在需要 Tool 分析时投影。 |
| Skill 显式字段 | `nullif(nullif("gen_ai.skill.name", ''), 'null') AS skill_name_explicit` | 可选字段；先检查覆盖率。非空时优先作为 Skill 名称。 |

响应中的 `observed_tokens` 使用 `coalesce(input_tokens, 0) + coalesce(output_tokens, 0)`；基础数值列仍保留 NULL，用于计算字段覆盖。两个事实源按相同投影合并，Tool、Skill、错误等字段仅在对应分析需要时补充。

#### 常用过滤条件

以下条件除错误事件外使用已清洗的别名。过滤所需字段必须已投影到当前层；直接查询原始行时使用对应源字段表达式。模型响应、工具调用等条件分别作用于相应事实范围，不应互相套用。例如原始行的 Tool call 条件是 `"event.name" IN ('gen_ai.tool.call', 'tool.call')`；`event_name` 是投影后的别名。

| 条件 | 表达式 | 用途 |
|---|---|---|
| 有效用户 | `user_id IS NOT NULL` | 用户统计；全量用量不因此丢弃缺失用户的事实 |
| 模型响应 | `event_name IN ('gen_ai.model.response', 'llm.response')` | 响应数、Token 与缓存分析 |
| 工具调用 | `event_name IN ('gen_ai.tool.call', 'tool.call')` | 调用数；结果事件不计入，调用本身不等于执行完成 |
| 有工具名 | `tool_name IS NOT NULL` | 工具名已按基础表达式清洗 |
| 有效缓存样本 | `input_tokens > 0 AND cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens` | 仅响应粒度；作为 `cache_valid`，无效/缺失样本另计 |
| 错误事件 | `nullif(nullif("error.type", ''), 'null') IS NOT NULL OR nullif(nullif("error.message", ''), 'null') IS NOT NULL` | 原始行条件；经 CTE 时需先投影相应错误列 |

#### Skill 来源与路径推断

Skill 名优先使用非空 `gen_ai.skill.name`。字段缺失时，可将文件路径单列为 `path_inferred` 候选；名称解析按实际目录布局确定，不把路径推断当作直接采集事实。

先确认路径字段的索引与分析配置：已建立动态子字段时可用 `"gen_ai.tool.call.arguments.file_path" AS skill_path`；仅保留 JSON 参数时使用 `json_extract_scalar("gen_ai.tool.call.arguments", '$.file_path') AS skill_path`。选择当前表实际支持的表达式，不能用 COALESCE 引用不存在的子字段。路径候选谓词为：

```sql
regexp_like(skill_path, '(?i)(/SKILL\.md|/[^/]+\.skill\.md)$')
```

该谓词只识别路径形态。确认 Skill 加载或工具执行还需核对工具种类、匹配结果或其他执行证据；不能将模型消息中的调用意图直接当作执行事实。

#### 时间粒度

`__time__` 为原始 Unix 秒；已投影为 `ts` 的 CTE 使用 `ts`。连续趋势保留日期，日内小时分布才折叠为 24 个时段。以下固定时差日桶假设报表采用 UTC+8；其他时区按其时区规则计算，不能直接沿用该偏移。

| 粒度 | Unix 秒桶表达式 | 展示与边界 |
|---|---|---|
| 连续小时 | `cast(floor(__time__ / 3600) * 3600 AS bigint) AS hour_ts` | 保留日期，按报表时区展示 |
| UTC+8 自然日 | `cast(floor((__time__ + 28800) / 86400) * 86400 - 28800 AS bigint) AS day_ts` | 桶值仍是 Unix 秒；按北京时间展示日期 |

缺失观测不直接当作业务零。周内分布保留星期与小时，避免与日内 24 小时分布混淆。

#### 可组合指标与可加性

| 指标 | 聚合原子 | 来源与汇总约束 |
|---|---|---|
| 事件数 / 响应数 | `count(*)` | 分别来自 `event_base` / `usage_events`，不额外去重 |
| 已观测 Token | `sum(observed_tokens)` | 仅模型响应；保留完整用量字段覆盖 |
| 活跃用户 | `approx_distinct(user_id)` | NULL 用户不计人数；跨组 distinct 数不可相加 |
| Session / Turn | 按对应身份键去重 | 保留用户、来源及会话上下文；跨组不可直接相加 |
| 平均响应用量 | `1.0 * sum(observed_tokens) / nullif(count(*), 0)` | `usage_events` 粒度；非整数除法，重算分子分母 |
| 缓存命中率 | `1.0 * sum(CASE WHEN cache_valid THEN cache_read_tokens END) / nullif(sum(CASE WHEN cache_valid THEN input_tokens END), 0)` | `usage_events` 中条件聚合；比率为 0–1，展示百分比时乘 100 |
| 有效缓存覆盖 | `1.0 * count_if(cache_valid) / nullif(count(*), 0)` | 有效缓存响应数 / 全部模型响应数；另列字段缺失与异常 |
| Tool / Skill | 在相应调用事实中按名称计数及用户去重 | 显式 Skill 与路径推断分开命名；不能跨组相加用户数 |
| 人群覆盖率 | 匹配事实的人群数 / 外表目标人群数 | 外表决定分母；零 Token 不等于未使用 |
| Token 集中度 | 先按用户汇总，再用窗口函数排名和累计 | 明确人群范围；分层互斥，按天分析时按日期分区 |

### 公共 CTE 组合示例

以下示例展示“事实合并与清洗 → 响应用量”的组合接口。按报表需要裁剪字段和 CTE，或补充已披露的工具等字段；完整查询以 `* |` 起始，在 CTE 后接目标 SELECT。

```sql
WITH event_raw AS (
  SELECT __time__ AS ts, "event.name" AS event_name, "user.id" AS user_id,
    "gen_ai.session.id" AS session_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.provider.name" AS provider,
    coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'),
      nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model,
    try_cast("gen_ai.usage.input_tokens" AS bigint) AS input_tokens,
    try_cast("gen_ai.usage.output_tokens" AS bigint) AS output_tokens,
    try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) AS cache_read_tokens
  FROM "agent-event"
  UNION ALL
  SELECT __time__ AS ts, "event.name" AS event_name, "user.id" AS user_id,
    "gen_ai.session.id" AS session_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.provider.name" AS provider,
    coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'),
      nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model,
    try_cast("gen_ai.usage.input_tokens" AS bigint) AS input_tokens,
    try_cast("gen_ai.usage.output_tokens" AS bigint) AS output_tokens,
    try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) AS cache_read_tokens
  FROM "agent-event-webtracking"
), event_base AS (
  SELECT ts, event_name,
    nullif(nullif(user_id, ''), 'null') AS user_id,
    nullif(nullif(session_id, ''), 'null') AS session_id,
    coalesce(nullif(nullif(agent_type, ''), 'null'), 'unknown') AS agent_type,
    coalesce(nullif(nullif(provider, ''), 'null'), 'unknown') AS provider,
    model, input_tokens, output_tokens, cache_read_tokens
  FROM event_raw
), usage_events AS (
  SELECT *, coalesce(input_tokens, 0) + coalesce(output_tokens, 0) AS observed_tokens,
    input_tokens > 0 AND cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens AS cache_valid
  FROM event_base
  WHERE event_name IN ('gen_ai.model.response', 'llm.response')
)
```

| 构件 | 粒度与用途 |
|---|---|
| `event_base` | 全部应用事件；用户活动、事件类型、Tool、Skill 等分析的基础 |
| `usage_events` | 模型响应；Token、缓存及用量字段覆盖统计的基础 |
| `event_user_day` / `active_user` | 按北京时间日期 × 用户 × Agent × 供应商 × 模型预聚合；事件数来自全部事件，Token 仅累计响应事件 |
| `user_activity` / `user_usage` | 在目标窗口内按用户预聚合，供人群及组织外表关联 |
| Session 聚合 | 包含用户、来源及 Session 身份，按需要保留 Agent、模型等维度；先聚合再关联标签或风险 |

## Source: intent_events

意图审计结果存储于共享的 `audit-event`。查询必须限定 `event_name IN ('intent.user_intent', 'intent.custom_user_intent')`，不能把同表的安全发现或 Skill 事实计为意图。`event_domain = 'user_intent'` 表示普通意图，`event_domain = 'security'` 表示风险意图。

| 字段 | 类型 | 说明 |
|---|---|---|
| `audit_event_id` | string | 审计结果标识。 |
| `event_name` | string | `intent.user_intent` 或 `intent.custom_user_intent`，区分默认与自定义意图识别。 |
| `event_domain` | string | 普通意图为 `user_intent`，风险意图为 `security`。 |
| `source_scope` | string | 证据来源范围；跨表关联必须保留，应用事实对应 `application`。 |
| `time_unix_nano` | int64 | 代表性用户输入的语义时间，单位为纳秒。 |
| `service_name` / `agent_type` / `user` | string | 应用、Agent 类型和用户平铺列；应用名可能缺失。 |
| `evidence_session_id` | string | 意图所属 Session。 |
| `evidence_event_id` | string | 代表性用户输入事件。 |
| `intent_category` / `intent_subcategory` | string | 普通意图分类与子类；风险意图不使用这两列。内置字面与父子关系见 `value-labels.md`，自定义意图按所属 taxonomy 取标签。 |
| `usage_total_tokens` | int64 | 按意图占比分摊的 Session Token；同一 Session 各意图行之和为其已分摊总量，不能再次重复累加 Session 总量。 |
| `risk_type` / `risk_subtype` / `severity` | string | 风险意图的风险分类及严重性。 |
| `reason` / `entities` | string / json | 识别摘要与实体快照，可能包含敏感内容。 |
| `detector_name` / `detector_version` | string | 识别器及版本。 |

### Session 与模型用量关联

- Session 关联键包含来源、用户、Session ID；不能仅用 Session ID，也不能跨 application/runtime 合并。应用名可用时辅助核验归属，缺失时不得构造多应用笛卡尔关联。
- 同一 Session 可以包含多个意图。先将事实聚合到目标 Session 粒度，再将意图归为 Session × 分类 × 子类的标签集合；标签归组不改变应用事件数，也不对应用事件 ID 去重。
- 意图属于多标签维度。标签组中的 Session 数及用量可以在组内统计；同一个 Session 可进入多个标签组，跨标签组不能直接相加。只需判断有无标签时，先生成唯一 Session 键集合再关联，避免复制事实行。
- `usage_total_tokens` 是意图分摊量，不含模型维度。没有明确的归属规则时，不将其直接分配给某个模型；Session 标签关联统计与按意图分摊统计应分别命名。
- 两侧使用明确的查询窗口，展示匹配与未匹配的事实组数及覆盖率。窗口内用量不等于完整 Session 生命周期用量；意图记录与应用响应落入窗口的时间可能不同。

## Source: incident_events

记录经过规则关联、过滤或提升的高保真风险，适用于风险明细、趋势、实体调查和证据回溯。该表不保存模型用量、业务成功或工单处置状态。

| **字段** | **类型** | **说明** |
| --- | --- | --- |
| `incident_event_id` | string | 高保真安全事件主键。该字段按确定性规则生成，适合用于去重、幂等写入和外部系统引用。 |
| `event_name` | string | 高保真事件名，固定采用 `incident.<risk_type>` 形式。来源事件类型、数据暴露位置和操作阶段不会编码进该字段。 |
| `source_scope` | enum | 数据来源范围，取值为 `application` 或 `runtime`，分别表示应用侧审计和运行时审计。 |
| `time_unix_nano` | int64 | 事件生成或证据链归并时间，单位为纳秒。页面查询仍以日志时间窗口过滤为准，该字段主要用于事实语义时间和证据回捞。 |
| `service_name` | string | 应用或服务名，无法明确时可为空或使用占位值。 |
| `agent_type` | string | Agent 类型，例如 qoder、cursor、claude-code 等。 |
| `user` | string | 用户实体的平铺查询列，优先取自 `user.id`。适合按用户筛选和分组。 |
| `host` | string | 主机实体的平铺查询列，优先取自 `host.name`；`host.name` 为空或缺失时，兼容使用 `__tag__:__hostname__`。 |
| `source_ip` | string | Agent 主机 IP 实体的平铺查询列，优先取自 `host.ip`；`host.ip` 为空或缺失时，兼容使用 `__source__`。该字段不表示网络对端或外联目标。 |
| `severity` | enum | 风险严重性，表示风险成立后可能造成的影响，从高到低取 `critical`、`high`、`medium`、`low`，页面上对应严重、高危、中危和低危。 |
| `confidence` | number | 系统对当前风险判断的确定程度，取值为 0 到 1。取值由相应的检测规则和当前证据确定。 |
| `risk_type` | string | 风险类型，对应产品中的主分类。该字段是配置风险筛选、通知规则和二次分析时最常用的分类字段，字面见 `value-labels.md`。 |
| `risk_subtype` | string | 风险子类，在所属 `risk_type` 下标识具体风险事实。对于敏感数据暴露事件，它通常表示敏感数据类型；对于敏感文件变更事件，它通常表示文件类型和动作。字面映射保留父类上下文，见 `value-labels.md`。 |
| `data_exposure_surface` | enum | 敏感数据的暴露位置，可为空；取 `agent_input`、`model_input`、`model_output`、`tool_input`、`tool_output`、`agent_output` 或 `network_egress`。该字段不表示操作是否已执行。 |
| `operation_stage` | enum | 当前证据能够确认的操作阶段，可为空；取 `intent`、`invoked`、`executed` 或 `completed`。历史空值显示为“阶段未记录”；该字段不表示操作成功或失败。 |
| `risk_signature` | string | 精确风险签名，用于识别同一个具体风险实例。适合做单个风险的去重、明细聚合和复现定位。 |
| `risk_family_key` | string | 同类风险聚合键，用于把同一类风险合并展示，适合风险队列、趋势和影响面分析。 |
| `reason` | string | 风险判定理由或证据摘要，可为空。由模型或其他语义研判生成的事件通常使用该字段说明风险为何成立。 |
| `evidence_security_event_ids` | string[] | 支撑该事件的低保真安全发现 ID 数组。 |
| `evidence_event_ids` | string[] | 支撑该事件的原始活动事件 ID 数组。 |
| `evidence_session_id` | string | 事件归属的证据 Session。`incident-event` 不保存顶层 `session_id`，Session 下钻和统计应使用该字段。 |
| `evidence_subject_type` | string | 证据主体类型，用于描述事件主要关联的主体类别。 |
| `evidence_subject_value` | string | 证据主体值，与 `evidence_subject_type` 配合使用。 |
| `evidence_subject_key` | string | 证据主体稳定键，用于更可靠地关联主体。 |
| `evidence_values` | object[] | 结构化证据值数组，例如命中的敏感类型、脱敏后的值、文件路径、命令片段、外发目标等。 |
| `entities` | object[] | 关键风险实体快照，例如应用、用户、主机、Agent 主机 IP、工具、域名、目标 IP、Secret、PII、文件路径或命令实体。多信号晋升事件应合并所有关键实体。 |
| `detector_name` | string | 生成该事件的检测器或服务名称。 |
| `detector_version` | string | 检测器或服务版本。 |

### 分类与关联

- `event_name` 采用 `incident.<risk_type>` 形式。`risk_type` 目录：`prompt_injection`、`model_refusal`、`sensitive_data_exposure`、`unexpected_code_execution`、`destructive_action`、`privilege_escalation`、`persistence`、`defense_impairment`、`credential_access`、`remote_control_channel`、`unauthorized_network_exposure`、`agent_misrepresentation`、`system_discovery`、`outbound_action`、`sensitive_file_mutation`。历史值保持原样，不能未经确认把旧类型合并到新分类。
- `severity`：`critical/high/medium/low`；`confidence`：0–1。`data_exposure_surface`：`agent_input/model_input/model_output/tool_input/tool_output/agent_output/network_egress`；`operation_stage`：`intent/invoked/executed/completed`。缺失阶段为“未记录”，`completed` 不代表成功，`network_egress` 不代表已发送成功。
- 风险条数按记录数统计，`incident_event_id` 用于明细引用与幂等关联。`risk_signature` 用于具体风险聚合，`risk_family_key` 用于同类风险聚合，三者计数不可混称“事件数”。同一 Session 可有多个风险，不能把 risk_type 分组后的去重 Session 数相加。
- Session 用 `evidence_session_id`，没有顶层 `session_id`。应用风险回捞先限定授权用户/应用和 `source_scope='application'`，再按 `evidence_session_id` 及 `evidence_event_ids` → `event.id` 查询两张应用事实表；runtime 风险回捞 `ebpf-event`。不要只靠时间或 trace_id 关联。
- 用量与风险先各自聚合到相同的用户/应用/Session 粒度再 JOIN，避免一条模型响应被多个风险及展开证据数组放大。无风险记录也不能断言安全。

## Source: dept_roster（外表关联示例）

外表用于补充事实中不存在的人群分母和业务维度。以下假设客户提供一张可在 SLS SQL 中引用的 `department` 花名册，并确认 `user.id = work_no`。它可以是部门维表 Logstore 或客户已配置的可关联外部表；实际表名、字段和读取方式按客户环境绑定。

### 假设表结构与关联契约

| 字段 | 类型 | 说明 |
|---|---|---|
| `work_no` | string | 员工工号；在选定的有效花名册内，一名员工一行 |
| `name` | string | 姓名，用于展示，不作为关联键 |
| `dept_name` | string | 完整部门路径；本例约定为“一级部门-二级部门-三级团队” |

- `work_no` 非空，并与事实侧 `user_id` 使用相同标识体系。若事件用户是账号或邮箱，先通过客户身份映射表转换，不能直接当作工号。
- 接入时确认员工范围、唯一部门归属、部门路径分隔符及花名册有效期。一人多部门或多个有效版本需要先约定归属、快照选择或分摊方式，不能任取一行。
- 花名册有效期与事实查询窗口分别确定。本例使用选定的一份有效花名册；如其存于 Logstore，确认读取范围能覆盖该快照，避免短时间查询遗漏员工。
- `dept_user` 是符合上述契约的员工维度，不通过按姓名、部门一起 GROUP BY 来掩盖一个工号的多重归属。

### 员工维度与部门层级

以下 CTE 接在公共事实 CTE 后。`department` 的结构、唯一性和分隔符均为本例假设；客户外表可替换为其他组织结构。

```sql
, dept_user AS (
  SELECT work_no, name, dept_name,
    coalesce(split_part(dept_name, '-', 1), '') AS dept_name_1,
    coalesce(split_part(dept_name, '-', 2), '') AS dept_name_2,
    coalesce(split_part(dept_name, '-', 3), '') AS dept_name_3
  FROM department
  WHERE work_no IS NOT NULL AND work_no <> ''
)
```

`dept_name_1`、`dept_name_2`、`dept_name_3` 分别表示一级部门、二级部门和三级团队。部门筛选作用于 `dept_user`，参与统计的分子和分母使用同一组织范围。

### 预聚合后关联：保留完整人群

先将事实聚合到用户粒度，再从员工维度 LEFT JOIN，可同时统计在册人数、使用人数和用量。以下片段续接上述 CTE，使用任意应用事件定义“使用”；Token 仍只取模型响应。

```sql
, user_activity AS (
  SELECT user_id, count(*) AS events
  FROM event_base WHERE user_id IS NOT NULL GROUP BY user_id
), user_usage AS (
  SELECT user_id, sum(observed_tokens) AS observed_tokens
  FROM usage_events WHERE user_id IS NOT NULL GROUP BY user_id
)
SELECT d.dept_name_2, d.dept_name_3,
  count(*) AS roster_users, count(a.user_id) AS active_users,
  round(100.0 * count(a.user_id) / nullif(count(*), 0), 2) AS coverage_pct,
  sum(coalesce(a.events, 0)) AS events,
  sum(coalesce(u.observed_tokens, 0)) AS observed_tokens
FROM dept_user d
LEFT JOIN user_activity a ON d.work_no = a.user_id
LEFT JOIN user_usage u ON d.work_no = u.user_id
GROUP BY d.dept_name_2, d.dept_name_3
```

示例中两张事实聚合表均为每用户一行，因此 LEFT JOIN 后仍为每员工一行，`count(*)` 才能作为在册人数。若保留日期、Agent、模型等维度，一名员工可对应多行；在册人数和使用人数应从员工集合重新去重统计，不能逐行计数或相加。

### 关联方向与指标边界

| 需求 | 关联模式 | 指标含义 |
|---|---|---|
| 组织覆盖、未使用员工、含零用量人群 | `dept_user LEFT JOIN user_activity/user_usage` | 花名册保留全部员工；未使用员工使用 `a.user_id IS NULL` 筛选 |
| 仅分析在册员工的已观测行为 | 事实预聚合后 INNER JOIN `dept_user` | 只保留属于选定花名册的事件用户，不用于推导全部在册人数 |
| 全量事实用量及组织匹配质量 | 事实预聚合后 LEFT JOIN `dept_user` | 保留未匹配用户，单列未归属用量；不因缺少花名册映射而丢失事实 |
| 按天覆盖与零用量趋势 | 日期集合 × `dept_user`，再 LEFT JOIN 对应日期事实 | 每天都有完整分母；日期范围与花名册有效期一致 |

LEFT JOIN 的事实时间、Agent、模型等条件在事实 CTE 中应用，避免在最终 WHERE 中过滤事实列而丢掉未使用员工。花名册侧的组织过滤可在 `dept_user` 中应用，或在外层对 `d` 的字段应用。

`active_user` / `event_user_day` 中的事件数及 Token 可在不重复的分组间相加；去重用户、Session、Turn、百分比及部门人数需要在目标粒度重算。若同一员工属于多个组织，只有已明确的分摊指标可跨组织相加。

其他外表沿用相同方法：先声明表结构和关联键，再确认一对一、多对一或多对多关系及有效期，确定保留事实还是保留目标人群，最后聚合。涉及历史部门归属时按事实时间匹配对应的有效版本；不使用当前花名册替代历史归属而不作说明。

## 枚举展示与交互

### 展示约定

- 默认中文，英文报表使用字典的 English 列。SQL 最终投影生成标签，图表只展示标签和指标；筛选、关联与聚合使用原始编码，不因翻译合并分类。
- 未知非空编码保留原文；NULL、空串及字段契约中的字面 `null` 清洗后显示“未记录 / Not recorded”，操作阶段为空显示“阶段未记录 / Stage not recorded”。不同编码出现同名标签时，用分类上下文区分。
- 子类映射保留父类。默认普通意图使用内置字典；自定义普通意图使用接入方确认的客户 taxonomy（含范围、版本和有效期），无法确定时保留原值，不假设存在未披露的 taxonomy 字段。风险意图使用风险字典，历史分类保留原编码。

### 筛选与交互

控件显示标签，实际筛选原值，例如“高危 → high”。控件支持独立显示名与替换值时直接配置这对值；下钻也传递原编码，按需保留非展示字段或显式反查映射。

大盘顶部 `droplistpro` 的静态别名和动态列表协议需按目标控件核对，不能直接套用表格值映射。若无法分离标签和值，控件使用标签选项，SQL 参数层按同一字典转回编码后过滤。两种传值方式不混用。

例如单选来源控件使用 `type=token`、`key=source_scope_label`、静态 `list=["全部", "应用侧", "运行时"]`。以下片段可接入查询，`i` 为风险事实别名：

```sql
WITH params AS (
  SELECT CASE '${{source_scope_label|全部}}'
    WHEN '应用侧' THEN 'application'
    WHEN '运行时' THEN 'runtime'
    ELSE '${{source_scope_label|全部}}' END AS source_code
)
-- 后续事实查询的 WHERE 条件：
-- ('${{source_scope_label|全部}}' = '全部'
--   OR i.source_scope = (SELECT source_code FROM params))
```

“全部 / All”表示不筛选，不对应事实中的 NULL；应避开真实标签中的同名值。多选和动态选项沿用控件的实际传值、转义和列表语法，映射保留父类及 taxonomy 上下文。验证候选、选中态、实际查询条件及结果，不能只检查配置字段。

### SQL 展示投影

下面展示“原值分组 → 标签投影”的通用模式。原值不出现在最终结果中；其他枚举按对应字典替换 CASE。筛选条件应在事实层作用于原始字段，关联也在标签投影之前完成。

```sql
* | WITH risk_counts AS (
  SELECT nullif(nullif(severity, ''), 'null') AS severity_code, count(*) AS events
  FROM "incident-event"
  GROUP BY nullif(nullif(severity, ''), 'null')
)
SELECT CASE severity_code
    WHEN 'critical' THEN '严重'
    WHEN 'high' THEN '高危'
    WHEN 'medium' THEN '中危'
    WHEN 'low' THEN '低危'
    ELSE coalesce(severity_code, '未记录') END AS "严重性",
  events AS "事件数"
FROM risk_counts
ORDER BY events DESC
```

## 参考文档

- [事实事件字段说明](https://help.aliyun.com/zh/agentloop/user-guide/fact-event-field-description)
- [风险事件字段说明](https://help.aliyun.com/zh/document_detail/3045695.html)
