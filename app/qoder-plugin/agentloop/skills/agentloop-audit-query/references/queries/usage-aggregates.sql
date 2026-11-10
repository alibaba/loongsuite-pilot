-- Append after application-base.sql.
, session_usage AS (
  SELECT source_scope, user_id, service_name, session_id,
    min(ts) AS first_time, max(ts) AS latest_time,
    sum(observed_tokens) AS session_tokens,
    count(DISTINCT turn_id) AS turn_count
  FROM usage_events WHERE session_id IS NOT NULL
  GROUP BY source_scope, user_id, service_name, session_id
), turn_usage AS (
  SELECT source_scope, user_id, service_name, session_id, turn_id,
    max(ts) AS latest_time, sum(observed_tokens) AS turn_tokens
  FROM usage_events WHERE session_id IS NOT NULL AND turn_id IS NOT NULL
  GROUP BY source_scope, user_id, service_name, session_id, turn_id
), session_model_usage AS (
  SELECT source_scope, user_id, service_name, session_id, model,
    sum(observed_tokens) AS session_tokens
  FROM usage_events WHERE session_id IS NOT NULL
  GROUP BY source_scope, user_id, service_name, session_id, model
)
