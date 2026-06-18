# AI Coding Agent Insight Schema

本 skill 的业务语义入口，覆盖 SLS 数据源绑定、字段 schema、报表层次、公共查询原子和 CTE 口径。报表 spec 默认只引用 logical source，不在每个 spec 中重复维护真实 project/logstore。

## Runtime Binding

- 默认 CLI profile: `test`
- 默认 project: `agentloop-xxx`
- 默认 region: `cn-shanghai`

| logical source | project | region | logstore | role | time field |
|---|---|---|---|---|---|
| `ai_coding_events` | `agentloop-xxx` | `cn-shanghai` | `agent-event-webtracking` | Agent 事件事实表 | `__time__` |
| `dept_roster` | `agentloop-xxx` | `cn-shanghai` | `department` | 可选员工/部门维表，仅团队层报表需要 | 无独立时间过滤 |

## Source Composition

| analysis need | required sources | can use | must not use |
|---|---|---|---|
| 只分析 Agent 事件事实 | `ai_coding_events` | 活跃用户、事件数、Token、Agent/模型/供应商、Skill、Tool、用户明细、Token 集中度 | 总在册人数、覆盖率、未产生日志员工列表、部门/团队 TopN、`dept_user` |
| 需要组织、覆盖率、在册员工或团队筛选 | `ai_coding_events`, `dept_roster` | 事件事实指标 + 总人数、覆盖率、团队明细、未产生日志员工列表、部门筛选、团队 TopN | 不适用 |

具体报表名称、模块和布局属于 `cases/loongsuite-pilot-insight/input/<scenario>-spec.md`；本文件只定义数据源能力和组合边界。

## Source: ai_coding_events

Agent 事件日志，每条记录对应一次 LoongSuite Pilot / AI Coding Agent 调用事件。

- **角色**: 主事实表
- **默认 chartQuery logstore**: `agent-event-webtracking`
- **SQL 约定**: 在该 logstore 的图表查询中，事件表可用 `FROM log`；跨 logstore CTE 中需要显式表名时，`agent-event-webtracking` 需用引号包裹为 `"agent-event-webtracking"`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `__time__` | long | 事件时间戳（Unix 秒） |
| `event.id` | text | 事件唯一 ID |
| `event.parent.id` | text | 父事件 ID |
| `event.name` | text | 事件类型，如 `llm.request`、`llm.response`、`tool.call`、`tool.result` |
| `user.id` | text | 用户工号 |
| `gen_ai.session.id` | text | 会话 ID |
| `gen_ai.turn.id` | text | Turn ID |
| `gen_ai.step.id` | text | Step ID |
| `gen_ai.agent.id` | text | Agent ID |
| `gen_ai.agent.name` | text | Agent 名称 |
| `gen_ai.agent.type` | text | Agent 类型 |
| `gen_ai.provider.name` | text | 模型供应商 |
| `gen_ai.request.id` | text | 请求 ID |
| `gen_ai.request.model` | text | 请求模型名 |
| `gen_ai.input.messages_delta` | json | 请求输入消息增量 |
| `gen_ai.response.id` | text | 模型响应 ID |
| `gen_ai.response.model` | text | 响应模型名；当 request.model 缺失时作为 fallback |
| `gen_ai.response.finish_reasons` | text | 响应结束原因 |
| `gen_ai.output.messages` | json | 响应输出消息内容 |
| `gen_ai.usage.input_tokens` | long | 输入 Token 数 |
| `gen_ai.usage.output_tokens` | long | 输出 Token 数 |
| `gen_ai.usage.total_tokens` | long | 总 Token 数 |
| `gen_ai.usage.cache_creation.input_tokens` | long | Cache creation 输入 Token 数 |
| `gen_ai.usage.cache_read.input_tokens` | long | Cache read 输入 Token 数 |
| `gen_ai.usage.input_cost` | double | 输入成本 |
| `gen_ai.usage.output_cost` | double | 输出成本 |
| `gen_ai.usage.total_cost` | double | 总成本 |
| `gen_ai.tool.name` | text | 工具名称 |
| `gen_ai.tool.call.id` | text | 工具调用 ID |
| `gen_ai.tool.call.exec.id` | text | 工具执行 ID |
| `gen_ai.tool.call.arguments` | json | 工具调用参数 |
| `gen_ai.tool.call.arguments.file_path` | text | 从工具调用参数索引出的文件路径；用于 Skill 名解析 |
| `gen_ai.tool.call.result` | json | 工具调用结果 |
| `gen_ai.tool.call.duration` | long | 工具调用耗时 |
| `error.type` | text | 错误类型 |
| `error.message` | text | 错误信息 |
| `trace_id` | text | Trace ID |
| `span_id` | text | Span ID |
| `parent_span_id` | text | Parent Span ID |
| `service.name` | text | 服务名 |
| `host.id` | text | 主机 ID |
| `host.ip` | text | 主机 IP |
| `host.name` | text | 主机名 |

### 常用过滤条件

- `event.name: "tool.call"` — 仅工具调用事件
- `"gen_ai.tool.name" IS NOT NULL` — 有工具名的事件
- `regexp_like("gen_ai.tool.call.arguments.file_path", '(?i)(/SKILL\.md|/[^/]+\.skill\.md)$')` — 可解析 Skill 名的事件；若本地只有 JSON 参数字段，再改用 `json_extract_scalar("gen_ai.tool.call.arguments", '$.file_path')`
- `"error.type" IS NOT NULL OR "error.message" IS NOT NULL` — 异常事件

### 派生字段

`gen_ai.skill.name` 当前线上没有赋值，不作为事实字段使用。

```sql
WHERE regexp_like(t."gen_ai.tool.call.arguments.file_path", '(?i)(/SKILL\.md|/[^/]+\.skill\.md)$')

CASE
  WHEN regexp_like(regexp_extract("gen_ai.tool.call.arguments.file_path", '/([^/]+)/[^/]+$', 1), '^v?[0-9]+\.[0-9]+')
  THEN regexp_extract("gen_ai.tool.call.arguments.file_path", '/([^/]+)/v?[0-9][^/]*/[^/]+$', 1)
  WHEN lower(regexp_extract("gen_ai.tool.call.arguments.file_path", '/([^/]+)/[^/]+$', 1)) IN ('skills', 'skill', '.claude', 'agents', 'resources', '.qoderwork', 'docs')
  THEN regexp_replace(regexp_extract("gen_ai.tool.call.arguments.file_path", '/([^/]+)$', 1), '(?i)(\.skill)?\.md$', '')
  ELSE regexp_extract("gen_ai.tool.call.arguments.file_path", '/([^/]+)/[^/]+$', 1)
END AS skill_name
```

### SQL 原子元素

这些元素来自当前报表的已校验查询，是可组合构件，不是完整图表 SQL。生成新报表时按 `事实层清洗 -> 可选维表 JOIN -> 目标聚合` 组合，按需裁剪未使用字段。

#### 基础清洗表达式

```sql
"user.id" AS user_id
coalesce(nullif("gen_ai.agent.type", 'null'), nullif("gen_ai.agent.name", 'null'), 'unknown') AS agent_type
coalesce(nullif("gen_ai.provider.name", 'null'), 'unknown') AS provider
coalesce(nullif("gen_ai.request.model", 'null'), nullif("gen_ai.response.model", 'null'), 'unknown') AS model
coalesce("gen_ai.usage.input_tokens", 0) AS input_tokens
coalesce("gen_ai.usage.output_tokens", 0) AS output_tokens
coalesce("gen_ai.usage.total_tokens", 0) AS total_tokens
```

- 有效事件用户：`"user.id" IS NOT NULL AND "user.id" <> ''`。
- `agent_type` 优先用 `gen_ai.agent.type`，缺失时 fallback 到 `gen_ai.agent.name`。
- `model` 优先用 request model，缺失时 fallback 到 response model。
- `'null'` 字符串按缺失值处理；空字符串暂不额外归一为 `NULL`，除非后续数据质量确认需要。

#### 时间粒度

```sql
date_trunc('day', __time__) AS t
date_format(from_unixtime(__time__), '%H:00') AS h
```

- 日趋势统一使用 `t` 作为时间列。
- 小时分布展示为 `HH:00`，例如 `09:00`、`18:00`；不要再输出整数小时。

#### 事实层聚合

`event_user_day` 用于大多数趋势、分布、明细和 Token 集中度视图：

```sql
SELECT
  date_trunc('day', __time__) AS t,
  "user.id" AS user_id,
  <agent_type> AS agent_type,
  <provider> AS provider,
  <model> AS model,
  sum(<input_tokens>) AS input_tokens,
  sum(<output_tokens>) AS output_tokens,
  sum(<total_tokens>) AS total_tokens,
  count(1) AS events
FROM log
WHERE "user.id" IS NOT NULL AND "user.id" <> ''
GROUP BY t, user_id, agent_type, provider, model
```

`event_user_hour` 用于 Token 使用时段分布：

```sql
SELECT
  date_format(from_unixtime(__time__), '%H:00') AS h,
  "user.id" AS user_id,
  sum(<total_tokens>) AS total_tokens
FROM log
WHERE "user.id" IS NOT NULL AND "user.id" <> ''
GROUP BY h, user_id
```

`tool_call` 用于工具调用 TopN：

```sql
nullif(nullif("gen_ai.tool.name", 'null'), '') AS tool_name
```

`skill_call` 用于 Skill TopN。线上优先使用已索引的扁平字段 `gen_ai.tool.call.arguments.file_path`；若本地数据只有 JSON 字段，再改用 `json_extract_scalar("gen_ai.tool.call.arguments", '$.file_path')`。

```sql
WHERE regexp_like(<file_path>, '(?i)(/SKILL\.md|/[^/]+\.skill\.md)$')

CASE
  WHEN regexp_like(regexp_extract(<file_path>, '/([^/]+)/[^/]+$', 1), '^v?[0-9]+\.[0-9]+')
  THEN regexp_extract(<file_path>, '/([^/]+)/v?[0-9][^/]*/[^/]+$', 1)
  WHEN lower(regexp_extract(<file_path>, '/([^/]+)/[^/]+$', 1)) IN ('skills', 'skill', '.claude', 'agents', 'resources', '.qoderwork', 'docs')
  THEN regexp_replace(regexp_extract(<file_path>, '/([^/]+)$', 1), '(?i)(\.skill)?\.md$', '')
  ELSE regexp_extract(<file_path>, '/([^/]+)/[^/]+$', 1)
END AS skill_name
```

#### 可组合指标

| 指标 | 推荐来源 | 聚合方式 | 备注 |
|---|---|---|---|
| 事件数 | `event_user_day.events` | `sum(events)` | count 可加 |
| 活跃用户数 | `event_user_day.user_id` | `approx_distinct(user_id)` | 事件层报表中的使用人数 |
| 输入/输出/总 Token | `event_user_day.*_tokens` | `sum(...)` | Token 可加 |
| 单事件平均 Token | `event_user_day` | `sum(total_tokens) / nullif(sum(events), 0)` | 表格中保留 2 位小数 |
| AI Agent / 模型 / 供应商占比 | `event_user_day` | 按维度 group，`sum(total_tokens)` | 饼图或 Top 表 |
| Tool 调用次数 | `tool_call.tool_name` | `count(1)` | 过滤空 tool |
| Skill 调用次数 | `skill_call.skill_name` | `count(1)` | 过滤空值和 `SKILL` |
| Skill 使用人数 | `skill_call.skill_name`, `user_id` | `approx_distinct(user_id)` | 不依赖部门维表 |

#### Token 集中度模式

集中度类图表使用三步组合：

1. `user_token`: 按用户汇总总 Token；事件层报表只包含有事件的用户，团队层报表可从 `dept_user` LEFT JOIN 保留 0 Token 员工。
2. `ranked`: 用 `row_number() OVER (ORDER BY total_tokens DESC)`、`count(1) OVER ()` 和 `sum(total_tokens) OVER ()` 得到排名、人数和总 Token。
3. 目标视图：Top10/Top20 占比、互斥分层或按天分区趋势。

互斥分层推荐：

| 分层 | 条件 | 说明 |
|---|---|---|
| `Top 10%` | `rn <= ceil(user_count * 0.10)` | 贡献最高的前 10% 用户 |
| `10%-20%` | `rn <= ceil(user_count * 0.20)` 且不在 Top10% | Top20% 扣除 Top10% |
| `后80%` | 其余用户 | 长尾用户 |

按天集中度趋势时，窗口函数都加 `PARTITION BY t`。

#### 事件层报表边界

当 spec 的 `data.sources` 只有 `ai_coding_events` 时：

- 可以生成活跃用户、事件数、Token、Agent/模型/供应商/Tool/Skill、用户明细和 Token 集中度。
- 不生成总在册人数、覆盖率、未产生日志员工列表、部门/团队 TopN；这些都需要 `dept_roster` 或客户自定义外表。
- 用户维度使用 `user_id`，展示名可写 `用户ID` 或 `工号`，但不能补充姓名、部门或团队。
- 不使用 `dept_user`、`dept_name_*` 或 `department`。

### 关联方式

通过 `"user.id"` 与员工维表的 `work_no` 关联。

## Source: dept_roster

部门花名册原始表，用于团队层报表的部门统计和覆盖率计算。事件层报表不依赖该表。

- **角色**: 维表（通过 CTE `dept_user` 引用）
- **logstore**: `department`
- **索引字段**: `dept_name`、`name`、`work_no`

| 字段 | 类型 | 说明 |
|------|------|------|
| `work_no` | text | 工号 |
| `name` | text | 姓名 |
| `dept_name` | text | 完整部门路径，建议使用 `一级部门-二级部门-三级组` 三段结构 |

### 数据清洗规则

- 有效员工：`work_no IS NOT NULL AND work_no <> ''`
- 不内置任何特定组织范围过滤；如客户需要限制事业部、外包或测试账号，在本文件中补充本地过滤规则。

### 部门层级拆分

```sql
COALESCE(SPLIT_PART(dept_name, '-', 1), '') AS dept_name_1  -- 一级部门/事业群/中台
COALESCE(SPLIT_PART(dept_name, '-', 2), '') AS dept_name_2  -- 二级部门（主要统计维度）
COALESCE(SPLIT_PART(dept_name, '-', 3), '') AS dept_name_3  -- 三级组/团队
```

### 公共 CTE

```sql
WITH dept_user AS (
  SELECT
    work_no,
    name,
    COALESCE(SPLIT_PART(dept_name, '-', 1), '') AS dept_name_1,
    COALESCE(SPLIT_PART(dept_name, '-', 2), '') AS dept_name_2,
    COALESCE(SPLIT_PART(dept_name, '-', 3), '') AS dept_name_3
  FROM department
  WHERE work_no IS NOT NULL AND work_no <> ''
  GROUP BY work_no, name, dept_name
),
active_user AS (
  SELECT
    date_trunc('day', __time__) AS t,
    "user.id" AS user_id,
    coalesce(nullif("gen_ai.agent.type", 'null'), nullif("gen_ai.agent.name", 'null'), 'unknown') AS agent_type,
    coalesce(nullif("gen_ai.provider.name", 'null'), 'unknown') AS provider,
    coalesce(nullif("gen_ai.request.model", 'null'), nullif("gen_ai.response.model", 'null'), 'unknown') AS model,
    sum(coalesce("gen_ai.usage.input_tokens", 0)) AS input_tokens,
    sum(coalesce("gen_ai.usage.output_tokens", 0)) AS output_tokens,
    sum(coalesce("gen_ai.usage.total_tokens", 0)) AS total_tokens,
    sum(coalesce("gen_ai.usage.input_cost", 0)) AS input_cost,
    sum(coalesce("gen_ai.usage.output_cost", 0)) AS output_cost,
    sum(coalesce("gen_ai.usage.total_cost", 0)) AS total_cost,
    count(1) AS events
  FROM log
  WHERE "user.id" IS NOT NULL AND "user.id" <> ''
  GROUP BY t, user_id, agent_type, provider, model
)
```

| CTE | GROUP BY | 用途 |
|-----|----------|------|
| `dept_user` | `work_no` | 花名册，含部门层级拆分 |
| `active_user` | `t`, `user_id`, `agent_type`, `provider`, `model` | 每天 × 用户 × Agent × 供应商 × 模型粒度汇总（Token/成本/事件） |

### 字段可加性

| 字段 | 外层可用 `sum()` | 说明 |
|------|:---:|------|
| `input_tokens` | Yes | 每条事件唯一属于一个 GROUP BY 组，sum 精确 |
| `output_tokens` | Yes | 同上 |
| `total_tokens` | Yes | 同上 |
| `input_cost` | Yes | 同上 |
| `output_cost` | Yes | 同上 |
| `total_cost` | Yes | 同上 |
| `events` | Yes | count 可加 |
| `approx_distinct(...)` | No | 不可加。同一实体可能跨多个 GROUP BY 组，sum 会膨胀 |

- JOIN 条件：`d.work_no = a.user_id`
- 查询前缀：团队层报表可继续使用 `*|`；需要跨 logstore CTE 时显式引用 `department`
- 按需裁剪：图表只需要部分 CTE 时，省略不用的即可
