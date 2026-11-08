# 意图审计参考 SQL

## 意图数量与趋势

```sql
* | SELECT count(*) AS intent_records,
  count_if(event_domain = 'security') AS risky_intent_records,
  1.0 * count_if(event_domain = 'security') / nullif(count(*), 0) AS risky_ratio
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
```

```sql
* | SELECT cast(floor(__time__ / 3600) * 3600 AS bigint) AS hour_ts,
  event_domain, count(*) AS intents
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
GROUP BY hour_ts, event_domain ORDER BY hour_ts, event_domain LIMIT 10000
```

## 意图分类与 Token 分布

```sql
* | SELECT intent_category, intent_subcategory,
  count(*) AS intents,
  sum(try_cast(usage_total_tokens AS bigint)) AS allocated_tokens
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
  AND event_domain = 'user_intent'
GROUP BY intent_category, intent_subcategory
ORDER BY intents DESC, intent_category, intent_subcategory LIMIT 10000
```

usage_total_tokens 是意图分摊量，不是完整 Session 用量。

## 用户与会话概览

```sql
* | SELECT source_scope, "user" AS user_id, service_name, evidence_session_id,
  count(*) AS intents, max(__time__) AS latest_time
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
GROUP BY source_scope, "user", service_name, evidence_session_id
ORDER BY latest_time DESC LIMIT 100
```

## 风险意图明细

```sql
* | SELECT audit_event_id, "user" AS user_id, risk_type, risk_subtype,
  severity, evidence_session_id, evidence_event_id
FROM "audit-event"
WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
  AND event_domain = 'security'
ORDER BY __time__ DESC, audit_event_id DESC LIMIT 0, 20
```

## 意图 × 模型 × 平均 Session Token

续接 [application-base.sql](application-base.sql) 和 [usage-aggregates.sql](usage-aggregates.sql)。

```sql
, labels AS (
  SELECT DISTINCT source_scope, "user" AS user_id,
    nullif(nullif(service_name, ''), 'null') AS service_name,
    evidence_session_id AS session_id, intent_category, intent_subcategory
  FROM "audit-event"
  WHERE event_name IN ('intent.user_intent','intent.custom_user_intent')
    AND event_domain = 'user_intent'
    AND __time__ >= {{from}} AND __time__ < {{to}}
)
SELECT i.intent_category, i.intent_subcategory, u.model,
  count(*) AS matched_session_model_groups,
  avg(u.session_tokens) AS avg_session_model_tokens
FROM session_model_usage u JOIN labels i
  ON u.source_scope = i.source_scope AND u.user_id = i.user_id
  AND u.session_id = i.session_id
  AND (u.service_name = i.service_name
    OR (u.service_name IS NULL AND i.service_name IS NULL))
GROUP BY i.intent_category, i.intent_subcategory, u.model
ORDER BY i.intent_category, i.intent_subcategory, u.model LIMIT 10000
```

同一 Session 可有多个意图，跨意图不能相加；关联覆盖与身份规则见 schema。
