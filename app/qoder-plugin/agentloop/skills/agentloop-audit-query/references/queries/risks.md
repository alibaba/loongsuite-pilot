# 风险概览与浏览参考 SQL

## 高危风险数与占比

```sql
* | SELECT count(*) AS risk_records,
  count_if(severity IN ('critical','high')) AS high_risk_records,
  1.0 * count_if(severity IN ('critical','high')) / nullif(count(*), 0) AS high_risk_ratio
FROM "incident-event"
WHERE risk_type IS NOT NULL AND risk_type <> '' AND risk_type <> '-'
```

此例按记录计数；需要风险对象数时使用 count(DISTINCT incident_event_id)。

## 风险分布与影响面

```sql
* | SELECT risk_type, risk_subtype,
  count(DISTINCT incident_event_id) AS risks,
  count(DISTINCT nullif(nullif(nullif(service_name, ''), 'null'), '-')) AS applications,
  count(DISTINCT nullif(nullif(nullif(agent_type, ''), 'null'), '-')) AS agent_types,
  count(DISTINCT nullif(nullif(nullif("user", ''), 'null'), '-')) AS users
FROM "incident-event" WHERE severity IN ('critical','high')
GROUP BY risk_type, risk_subtype
ORDER BY applications DESC, risks DESC, risk_type, risk_subtype
```

## 日周对比与恶化风险

以下查询续接 [risk-periods.sql](risk-periods.sql)。接口时间覆盖当前、前日和前周三个窗口。

```sql
SELECT * FROM risk_growth ORDER BY current_count DESC, risk_type, risk_subtype
```

恶化评分兼顾增长量与增长率，保留内置参考中的平滑和封顶参数。

```sql
, deltas AS (
  SELECT *, current_count - previous_day_count AS day_delta,
    current_count - previous_week_count AS week_delta
  FROM risk_growth
), scored AS (
  SELECT *, ln(current_count + 1) * (
    greatest(day_delta, 0) * least(greatest(
      1.0 * day_delta / greatest(previous_day_count, 10), 0), 3)
    + 0.5 * greatest(week_delta, 0) * least(greatest(
      1.0 * week_delta / greatest(previous_week_count, 10), 0), 3)) AS score
  FROM deltas WHERE current_count > 0 AND (day_delta > 0 OR week_delta > 0)
)
SELECT * FROM scored
ORDER BY score DESC, current_count DESC, risk_type, risk_subtype LIMIT 1
```

## 风险摘要与趋势

```sql
* | SELECT cast(floor(__time__ / 3600) * 3600 AS bigint) AS hour_ts,
  count(DISTINCT incident_event_id) AS risks,
  count(DISTINCT CASE WHEN severity IN ('critical','high')
    THEN incident_event_id END) AS high_risks,
  count(DISTINCT risk_type) AS risk_types
FROM "incident-event" GROUP BY hour_ts ORDER BY hour_ts
```

摘要移除时间分组；会话影响面按 schema 的完整身份聚合。

## 风险事件列表

```sql
* | SELECT __time__ AS event_time, incident_event_id, source_scope,
  service_name, agent_type, "user" AS user_id, severity, confidence,
  risk_type, risk_subtype, data_exposure_surface, operation_stage, evidence_session_id
FROM "incident-event"
ORDER BY __time__ DESC, incident_event_id DESC LIMIT 0, 20
```

## 检测发现分布

```sql
* | SELECT event_name, count(*) AS finding_records
FROM "audit-event"
WHERE event_domain = 'security'
  AND event_name NOT IN ('intent.user_intent','intent.custom_user_intent')
GROUP BY event_name ORDER BY finding_records DESC, event_name LIMIT 20
```

检测发现与 incident 风险是不同对象，分别统计。
