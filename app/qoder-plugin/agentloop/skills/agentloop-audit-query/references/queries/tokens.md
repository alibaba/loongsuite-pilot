# Token 分析参考 SQL

响应口径使用 [application-base.sql](application-base.sql)；Session / Turn 查询再续接 [usage-aggregates.sql](usage-aggregates.sql)。完整形式为 `* |` + CTE + SELECT。响应与调用归并的区别见 [schema](../schema.md#token-查询口径)。

## 总量、用户与模型排行

```sql
SELECT user_id, sum(observed_tokens) AS total_tokens,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  count(*) AS model_responses,
  count_if(input_tokens IS NOT NULL AND output_tokens IS NOT NULL) AS complete_responses
FROM usage_events WHERE user_id IS NOT NULL
GROUP BY user_id ORDER BY total_tokens DESC, user_id LIMIT 20
```

模型或 Agent 排行将 SELECT、GROUP BY、ORDER BY 中的 user_id 同时替换为 model 或 agent_type，并移除 `WHERE user_id IS NOT NULL`，保留匿名用量。总量单独查询：

```sql
SELECT sum(observed_tokens) AS total_tokens,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  count(*) AS model_responses,
  count_if(input_tokens IS NOT NULL AND output_tokens IS NOT NULL) AS complete_responses
FROM usage_events
```

调用归并使用 [call-usage.sql](call-usage.sql)。先确认稳定 ID 覆盖，再聚合调用：

```sql
SELECT token_events, unkeyed_events FROM token_source_quality_t
```

unkeyed_events=0 时：

```sql
SELECT count(*) AS calls, sum(total_tokens) AS total_tokens FROM token_call_t
```

## Token 趋势与平均消耗

```sql
SELECT cast(floor(ts / 3600) * 3600 AS bigint) AS hour_ts,
  sum(observed_tokens) AS total_tokens
FROM usage_events GROUP BY hour_ts ORDER BY hour_ts LIMIT 10000
```

平均 Session 消耗先聚合会话，再按末次观测时间归桶。

```sql
SELECT cast(floor(latest_time / 3600) * 3600 AS bigint) AS hour_ts,
  avg(session_tokens) AS avg_session_tokens
FROM session_usage GROUP BY hour_ts ORDER BY hour_ts LIMIT 10000
```

平均 Turn 消耗将 session_usage/session_tokens 换为 turn_usage/turn_tokens。周期对比使用相同 SQL 分别查询当前与比较窗口；固定 24 小时视图以选定范围的结束时间为锚点。

## Session 排名、P95 与分桶

```sql
SELECT * FROM session_usage
ORDER BY session_tokens DESC, source_scope, user_id, service_name, session_id LIMIT 20
```

全量 P95 在 LIMIT 前计算；内置面板的 Top Session 样本 P95 需要使用同样样本。

```sql
SELECT approx_percentile(session_tokens, 0.95) AS p95_session_tokens FROM session_usage
```

```sql
SELECT CASE WHEN session_tokens < 10000 THEN '0-10k'
    WHEN session_tokens < 50000 THEN '10k-50k'
    WHEN session_tokens < 100000 THEN '50k-100k'
    WHEN session_tokens < 500000 THEN '100k-500k'
    WHEN session_tokens < 1000000 THEN '500k-1M' ELSE '1M+' END AS bucket,
  count(*) AS sessions
FROM session_usage GROUP BY bucket ORDER BY min(session_tokens)
```

Turn 分布使用 turn_usage/turn_tokens，桶边界为 1k、5k、10k、50k、100k。

## 长对话与消耗集中度

```sql
SELECT turn_count, count(*) AS sessions,
  avg(latest_time - first_time) AS avg_duration_seconds,
  avg(session_tokens) AS avg_tokens,
  approx_percentile(session_tokens, 0.95) AS p95_tokens
FROM session_usage GROUP BY turn_count ORDER BY turn_count LIMIT 10000
```

按 Turn 数分桶即可生成长对话分布；缺失 Turn ID 不计真实轮数。

```sql
, ranked AS (
  SELECT session_tokens,
    row_number() OVER (ORDER BY session_tokens DESC,
      source_scope, user_id, service_name, session_id) AS rank_no,
    count(*) OVER () AS session_count,
    sum(session_tokens) OVER () AS scope_tokens
  FROM session_usage
)
SELECT 1.0 * sum(CASE WHEN rank_no <= greatest(1, ceil(session_count * 0.1))
    THEN session_tokens ELSE 0 END) / nullif(max(scope_tokens), 0) AS top10_share
FROM ranked
```

此例计算前 10% Session 的 Token 贡献，人数向上取整。

## Turn / Step 明细

```sql
SELECT source_scope, user_id, service_name, session_id, turn_id, step_id, model,
  sum(observed_tokens) AS total_tokens
FROM usage_events
GROUP BY source_scope, user_id, service_name, session_id, turn_id, step_id, model
ORDER BY total_tokens DESC LIMIT 100
```

## 缓存命中率

```sql
SELECT model,
  1.0 * sum(CASE WHEN cache_valid THEN cache_read_tokens END)
    / nullif(sum(CASE WHEN cache_valid THEN input_tokens END), 0) AS cache_hit_ratio,
  count_if(cache_valid) AS valid_responses, count(*) AS responses
FROM usage_events GROUP BY model ORDER BY model LIMIT 10000
```

有效样本定义见 schema；输入已包含缓存，计算总 Token 时不重复相加。
