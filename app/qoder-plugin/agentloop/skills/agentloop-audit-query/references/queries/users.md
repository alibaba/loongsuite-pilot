# 用户风险参考 SQL

## 用户风险排行

```sql
* | SELECT "user" AS user_id,
  count(DISTINCT incident_event_id) AS risk_count,
  count(DISTINCT CASE WHEN severity IN ('critical','high')
    THEN incident_event_id END) AS high_risk_count,
  max(__time__) AS latest_time
FROM "incident-event"
WHERE "user" IS NOT NULL AND "user" <> '' AND "user" <> 'null' AND "user" <> '-'
GROUP BY "user"
ORDER BY high_risk_count DESC, risk_count DESC, latest_time DESC, user_id LIMIT 20
```

此例按平铺用户字段统计；产品实体归一的用户视角使用 type=user 的稳定实体 ID。

## 用户概览、时段与构成

```sql
* | SELECT "user" AS user_id, risk_type, risk_subtype, severity,
  cast(floor(__time__ / 3600) * 3600 AS bigint) AS hour_ts,
  count(DISTINCT incident_event_id) AS risks
FROM "incident-event"
GROUP BY "user", risk_type, risk_subtype, severity, hour_ts
ORDER BY hour_ts, user_id
```

移除不需要的分组维度，可分别得到用户概览、时间分布或风险构成。

## 相关实体与具体风险

续接 [entity-base.sql](entity-base.sql)：

```sql
SELECT user_id, entity_type, entity_id,
  count(DISTINCT incident_event_id) AS risks
FROM incident_entities WHERE entity_id IS NOT NULL
GROUP BY user_id, entity_type, entity_id ORDER BY risks DESC LIMIT 100
```

具体风险使用 [风险事件列表](risks.md#风险事件列表)，按用户收窄。
