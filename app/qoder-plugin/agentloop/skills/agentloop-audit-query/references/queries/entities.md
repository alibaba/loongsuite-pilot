# 实体调查参考 SQL

以下查询续接 [entity-base.sql](entity-base.sql)，完整形式为 `* |` + CTE + SELECT。字段见 [schema](../schema.md)。

## 实体类型与清单

```sql
SELECT entity_type, count(DISTINCT entity_id) AS entities,
  min(ts) AS first_time, max(ts) AS latest_time
FROM entity_occurrences WHERE entity_id IS NOT NULL
GROUP BY entity_type ORDER BY entities DESC, entity_type LIMIT 100
```

实体清单按类型和稳定 ID 聚合，出现次数按事实去重。

```sql
SELECT entity_type, entity_id,
  count(DISTINCT json_format(CAST(ARRAY[fact_source, fact_id] AS JSON))) AS fact_count,
  min(ts) AS first_time, max(ts) AS latest_time
FROM entity_occurrences WHERE entity_id IS NOT NULL
GROUP BY entity_type, entity_id
ORDER BY latest_time DESC, entity_type, entity_id LIMIT 100
```

## 实体画像与关联风险

事实与风险分别聚合再关联；FULL JOIN 保留仅在风险中出现的实体。

```sql
, facts AS (
  SELECT entity_type, entity_id, min(ts) AS first_time, max(ts) AS latest_time
  FROM entity_occurrences WHERE entity_id IS NOT NULL
  GROUP BY entity_type, entity_id
), risks AS (
  SELECT entity_type, entity_id,
    count(DISTINCT incident_event_id) AS risk_count,
    count(DISTINCT CASE WHEN severity IN ('critical','high')
      THEN incident_event_id END) AS high_risk_count
  FROM incident_entities WHERE entity_id IS NOT NULL
  GROUP BY entity_type, entity_id
)
SELECT coalesce(f.entity_type, r.entity_type) AS entity_type,
  coalesce(f.entity_id, r.entity_id) AS entity_id,
  f.first_time, f.latest_time, r.risk_count, r.high_risk_count
FROM facts f FULL JOIN risks r
  ON f.entity_type = r.entity_type AND f.entity_id = r.entity_id
ORDER BY entity_type, entity_id LIMIT 10000
```

## 出现会话

```sql
SELECT entity_type, entity_id, source_scope, user_id, service_name, session_id,
  min(ts) AS first_time, max(ts) AS latest_time
FROM entity_occurrences WHERE entity_id IS NOT NULL AND session_id IS NOT NULL
GROUP BY entity_type, entity_id, source_scope, user_id, service_name, session_id
ORDER BY latest_time DESC, entity_type, entity_id LIMIT 100
```

## 共现关系与证据

以下查询返回与焦点实体同事件出现的其他实体；`{{entity_id}}` 为转义后的 SQL 字符串内容。

```sql
, focus_facts AS (
  SELECT DISTINCT fact_source, fact_id
  FROM entity_occurrences WHERE entity_id = '{{entity_id}}'
)
SELECT e.entity_type, e.entity_id, 'same_event' AS relation_type,
  e.fact_source, e.fact_id, e.source_scope, e.session_id
FROM entity_occurrences e JOIN focus_facts f
  ON e.fact_source = f.fact_source AND e.fact_id = f.fact_id
WHERE e.entity_id <> '{{entity_id}}'
ORDER BY e.fact_source, e.fact_id, e.entity_type, e.entity_id,
  e.source_scope, e.session_id LIMIT 10000
```

同会话共现改用完整会话身份关联。调用、文件访问和外联关系需要对应原事件证据；共现不表示因果或操作已执行。
