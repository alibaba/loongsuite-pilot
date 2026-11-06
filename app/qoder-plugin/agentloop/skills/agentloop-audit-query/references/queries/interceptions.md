# 拦截记录参考 SQL

以下查询续接 [interception-base.sql](interception-base.sql)，完整形式为 `* |` + CTE + SELECT。

## 触发与拦截数量

```sql
SELECT count(*) AS triggered_events, count_if(action = 'block') AS blocked_events
FROM guardrail_events WHERE triggered = 'true'
```

## 拦截趋势与分布

```sql
SELECT cast(floor(ts / 3600) * 3600 AS bigint) AS hour_ts, count(*) AS blocked_events
FROM guardrail_events WHERE triggered = 'true' AND action = 'block'
GROUP BY hour_ts ORDER BY hour_ts
```

按用户、Agent 等维度分组可查看对应分布。

## 拦截记录列表

```sql
SELECT ts, event_id, user_id, agent_type, session_id
FROM guardrail_events WHERE triggered = 'true' AND action = 'block'
ORDER BY ts DESC, event_id DESC LIMIT 0, 20
```
