-- CTE fragment. Append a SELECT and use the same API time range.
WITH entity_facts AS (
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
), incident_entities AS (
  SELECT i.__time__ AS ts, i.incident_event_id, i.source_scope,
    i."user" AS user_id, i.service_name, i.evidence_session_id AS session_id,
    i.severity, i.risk_type, i.risk_subtype,
    lower(json_extract_scalar(e, '$.type')) AS entity_type,
    coalesce(nullif(json_extract_scalar(e, '$.id'), ''),
      nullif(json_extract_scalar(e, '$.entity_id'), '')) AS entity_id
  FROM "incident-event" i
  CROSS JOIN UNNEST(try(CAST(json_parse(coalesce(nullif(i.entities, ''), '[]'))
    AS ARRAY(JSON)))) AS t(e)
)
