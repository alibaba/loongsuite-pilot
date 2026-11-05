# 实体调查配方

口径 `entity-occurrence.v1`。实体事实可来自 audit-event 中安全发现（排除意图事件）及 canonical Skill Read 上下文：`event_domain='agent_context' AND event_name='skill.read'`。有历史 security-event 时按确认的兼容契约合并，保留来源与事实 ID；没有时裁剪并披露覆盖。只有 incident.entities 时仅能形成“风险关联实体”视角。

## 数组与标识契约

entities 为 JSON 数组，元素使用 type、id（兼容 entity_id）及 display_name/display_hint/value。ID 是关联键，展示值可能敏感；只输出已脱敏展示，不能假设所有 value 都已脱敏。索引配置为 JSON 不代表 SQL 返回类型是 JSON；SLS 的 entities 可能仍为 VARCHAR，此时必须先 json_parse 再转 ARRAY(JSON)。TRY 包裹解析/转换用于隔离坏 JSON；缺失、坏 JSON 及空数组需单列覆盖，不能默默当作无实体。已确认为原生 JSON 类型的目标才直接转换，不能用不存在字段 COALESCE。

```sql
* | WITH entity_facts AS (
  SELECT __time__ AS ts, 'audit-event' AS fact_source, audit_event_id AS fact_id,
    source_scope, "user" AS user_id, service_name, evidence_session_id AS session_id,
    try(CAST(json_parse(coalesce(nullif(entities, ''), '[]')) AS ARRAY(JSON))) AS entity_array
  FROM "audit-event"
  WHERE (event_domain = 'security'
      AND event_name NOT IN ('intent.user_intent','intent.custom_user_intent'))
    OR (event_domain = 'agent_context' AND event_name = 'skill.read')
), entity_occurrences AS (
  SELECT f.ts, f.fact_source, f.fact_id, f.source_scope, f.user_id,
    f.service_name, f.session_id,
    lower(json_extract_scalar(e, '$.type')) AS entity_type,
    coalesce(nullif(json_extract_scalar(e, '$.id'), ''),
      nullif(json_extract_scalar(e, '$.entity_id'), '')) AS entity_id
  FROM entity_facts f CROSS JOIN UNNEST(f.entity_array) AS t(e)
)
SELECT entity_type, count(DISTINCT entity_id) AS entities,
  count(*) AS occurrences, min(ts) AS first_time, max(ts) AS latest_time
FROM entity_occurrences
WHERE entity_id IS NOT NULL
GROUP BY entity_type ORDER BY entities DESC, entity_type LIMIT 100
```

实体清单改为 entity_type + entity_id 分组，并以来源 + fact_id 去重计事实出现数；不要把数组中重复项算作新的事实。会话数按来源、用户、应用、Session 复合身份聚合。Secret/PII 的实体稳定 ID 可用于关联，不要求返回真实值；不从明文构造新的公开示例。

## 风险附着、画像与证据

incident 另展开 entities，按 incident_event_id + entity_type + entity_id 去重，计算高危与各级风险数、风险类型及最近时间，再 LEFT JOIN 实体清单。没有风险记录表示未关联到当前观测，不表示实体安全。只在高危事件中出现但未在事实清单中的实体应单列来源，不丢掉它们。

画像按稳定类型与 ID 精确筛选，返回首次/末次观测、关联风险时间线和出现会话。回溯时先读证据标识，再按来源选择 application 两表或 ebpf-event；授权身份和明确事件引用优先，不能凭同一时间段猜关联。

## 共现关系与行为关系

从 entity_occurrences 先生成焦点实体的唯一事实键集合，再取同一事实的其他实体（same_event）；同会话共现使用完整会话身份（same_session）。返回边表：source_entity_id、target_entity_id、relation_type、evidence_fact_source、evidence_fact_id、source_scope、session_id。避免未经预过滤的全实体两两自 JOIN。

同一实体对两种共现均成立时可优先展示 same_event，但保留证据类别。共现不能命名为“调用”“访问”或“外发”。明确行为边必须回溯原事件中的工具调用、目标文件或网络对端等证据，并保留 operation_stage；模型生成的操作意图不能证明已执行。调查结果是可核查的关系表及证据，不要求复刻产品关系图布局。
