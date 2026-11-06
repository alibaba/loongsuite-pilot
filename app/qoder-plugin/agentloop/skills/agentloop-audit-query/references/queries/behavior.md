# 行为分析参考 SQL

以下查询续接 [application-base.sql](application-base.sql)，完整形式为 `* |` + CTE + SELECT。

## 活跃 Agent、会话与行为量

```sql
SELECT count(DISTINCT nullif(nullif(agent_id, ''), 'null')) AS active_agents,
  count(DISTINCT CASE WHEN session_id IS NOT NULL THEN
    json_format(CAST(ARRAY[source_scope, user_id, service_name, session_id] AS JSON))
  END) AS sessions,
  count_if(event_name = 'gen_ai.model.request') AS model_requests,
  count_if(event_name = 'gen_ai.tool.call') AS tool_calls,
  count_if(event_name IN ('gen_ai.model.request','gen_ai.model.response',
    'gen_ai.tool.call','gen_ai.tool.result')) AS total_behavior
FROM event_base
```

## 行为趋势与构成

```sql
SELECT cast(floor(ts / 3600) * 3600 AS bigint) AS hour_ts,
  agent_type, event_name, count(*) AS events
FROM event_base
GROUP BY hour_ts, agent_type, event_name ORDER BY hour_ts, agent_type, event_name
```

按 model、tool_name 分组可得到模型和工具构成；命令、文件、网络分类按 schema 中的工具语义提取。

## 工具错误率

以下统计工具调用事件自带的错误标记。

```sql
SELECT tool_name, count(*) AS tool_calls,
  count_if(nullif(nullif(error_type, ''), 'null') IS NOT NULL
    OR nullif(nullif(error_message, ''), 'null') IS NOT NULL) AS errors,
  1.0 * count_if(nullif(nullif(error_type, ''), 'null') IS NOT NULL
    OR nullif(nullif(error_message, ''), 'null') IS NOT NULL) / count(*) AS error_rate
FROM event_base WHERE event_name = 'gen_ai.tool.call'
GROUP BY tool_name ORDER BY error_rate DESC, tool_name LIMIT 20
```

错误仅在结果事件中时，先按完整 Tool Call 身份聚合结果再关联调用。

## 高活跃 Session 与时长

```sql
SELECT source_scope, user_id, service_name, session_id,
  min(ts) AS first_time, max(ts) AS latest_time,
  max(ts) - min(ts) AS observed_duration_seconds,
  count_if(event_name IN ('gen_ai.model.request','gen_ai.model.response',
    'gen_ai.tool.call','gen_ai.tool.result')) AS total_behavior
FROM event_base WHERE session_id IS NOT NULL
GROUP BY source_scope, user_id, service_name, session_id
ORDER BY total_behavior DESC, latest_time DESC, session_id LIMIT 20
```

时长为查询窗口内首尾观测时间差；按该结果分桶可生成 Session 时长分布。

## Turn 动作分布与日内活跃度

```sql
, turns AS (
  SELECT source_scope, user_id, service_name, session_id, turn_id,
    min(ts) AS first_time,
    count_if(event_name = 'gen_ai.tool.call' AND
      tool_name IN ('write','edit','apply_patch','exec','Write','Edit','MultiEdit',
        'Bash','Shell','exec_command','run_in_terminal')) AS actions
  FROM event_base WHERE session_id IS NOT NULL AND turn_id IS NOT NULL
  GROUP BY source_scope, user_id, service_name, session_id, turn_id
)
SELECT actions, count(*) AS turns FROM turns GROUP BY actions ORDER BY actions
```

Turn 动作量不等于业务产出。日内活跃度使用同一 turns CTE，将末尾 SELECT 换为：

```sql
SELECT cast(floor((first_time + 28800) / 3600) AS bigint) % 24 AS hour_of_day,
  count(*) AS turns
FROM turns GROUP BY hour_of_day ORDER BY hour_of_day
```

此例按 UTC+8 统计 0–23 小时分布。
