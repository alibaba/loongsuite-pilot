-- CTE fragment for model call aggregation, application sources only.
-- Use the same API time bounds for all sources. Append the required SELECT.
WITH token_event_source_t AS (
  SELECT
    __time__,
    'application' AS source_scope,
    time_unix_nano,
    "event.id",
    "event.name",
    "__tag__:__service_name__",
    "service.name",
    "gen_ai.agent.type",
    "gen_ai.session.id",
    "gen_ai.turn.id",
    "gen_ai.step.id",
    "gen_ai.tool.call.id",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.response.finish_reasons",
    "gen_ai.input.messages_delta",
    "gen_ai.output.messages",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.provider.name",
    "user.id",
    "__tag__:__hostname__",
    "host.name",
    __source__,
    "host.ip"
  FROM "agent-event" WHERE __time__ >= {{from}} AND __time__ < {{to}}
  UNION ALL
  SELECT
    __time__,
    'application' AS source_scope,
    time_unix_nano,
    "event.id",
    "event.name",
    "__tag__:__service_name__",
    "service.name",
    "gen_ai.agent.type",
    "gen_ai.session.id",
    "gen_ai.turn.id",
    "gen_ai.step.id",
    "gen_ai.tool.call.id",
    "gen_ai.request.model",
    "gen_ai.response.model",
    CAST(NULL AS VARCHAR) AS "gen_ai.response.finish_reasons",
    CAST(NULL AS VARCHAR) AS "gen_ai.input.messages_delta",
    CAST(NULL AS VARCHAR) AS "gen_ai.output.messages",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.provider.name",
    "user.id",
    "__tag__:__hostname__",
    "host.name",
    __source__,
    "host.ip"
  FROM "agent-event-webtracking" WHERE __time__ >= {{from}} AND __time__ < {{to}}
),
token_source_quality_t AS (
  SELECT count(*) AS token_events,
    count_if(nullif(nullif("event.id", ''), 'null') IS NULL) AS unkeyed_events
  FROM token_event_source_t
  WHERE "gen_ai.usage.input_tokens" IS NOT NULL
    OR "gen_ai.usage.output_tokens" IS NOT NULL
    OR "gen_ai.usage.total_tokens" IS NOT NULL
),
token_event_t AS (
  SELECT
    __time__,
    source_scope,
    COALESCE(time_unix_nano / 1000000000, __time__) AS event_time,
    nullif(nullif("event.id", ''), 'null') AS event_id,
    CASE
      WHEN "event.name" = 'llm.request' THEN 'gen_ai.model.request'
      WHEN "event.name" = 'llm.response' THEN 'gen_ai.model.response'
      ELSE "event.name"
    END AS event_name,
    COALESCE(nullif(nullif("__tag__:__service_name__", ''), 'null'), nullif(nullif("service.name", ''), 'null'), '-') AS service_name,
    CASE
      WHEN source_scope = 'runtime' AND nullif("gen_ai.agent.type", '') LIKE 'eBPF:%' THEN "gen_ai.agent.type"
      WHEN source_scope = 'runtime' AND nullif("gen_ai.agent.type", '') IS NOT NULL THEN concat('eBPF:', nullif("gen_ai.agent.type", ''))
      ELSE COALESCE(nullif(nullif("gen_ai.agent.type", ''), 'null'), 'unknown')
    END AS agent_type,
    "gen_ai.session.id" AS session_id,
    "gen_ai.turn.id" AS turn_id,
    "gen_ai.step.id" AS step_id,
    "gen_ai.tool.call.id" AS tool_call_id,
    COALESCE(nullif("gen_ai.request.model", ''), nullif("gen_ai.response.model", ''), 'unknown') AS model,
    COALESCE(nullif("gen_ai.provider.name", ''), '-') AS model_provider,
    COALESCE(nullif("user.id", ''), '-') AS user_id,
    COALESCE(nullif(nullif("host.name", ''), 'null'), nullif(nullif("__tag__:__hostname__", ''), 'null'), '-') AS host_name,
    COALESCE(nullif(nullif("host.ip", ''), 'null'), nullif(nullif(__source__, ''), 'null'), '-') AS host_ip,
    CAST("gen_ai.response.finish_reasons" AS VARCHAR) AS finish_reasons,
    CAST("gen_ai.input.messages_delta" AS VARCHAR) AS input_messages_delta,
    CAST("gen_ai.output.messages" AS VARCHAR) AS output_messages,
    try_cast("gen_ai.usage.input_tokens" AS BIGINT) AS input_tokens,
    try_cast("gen_ai.usage.output_tokens" AS BIGINT) AS output_tokens,
    try_cast("gen_ai.usage.total_tokens" AS BIGINT) AS total_tokens
  FROM token_event_source_t
  WHERE ("gen_ai.usage.input_tokens" IS NOT NULL
    OR "gen_ai.usage.output_tokens" IS NOT NULL
    OR "gen_ai.usage.total_tokens" IS NOT NULL)
),
token_call_t AS (
  SELECT
    source_scope,
    COALESCE(nullif(nullif(session_id, ''), 'null'), '-') AS session_id,
    json_format(CAST(ARRAY[source_scope, user_id, service_name,
      COALESCE(nullif(nullif(session_id, ''), 'null'), '-')] AS JSON)) AS session_scope_key,
    COALESCE(nullif(turn_id, ''), concat('event-turn:', event_id)) AS turn_id,
    COALESCE(nullif(step_id, ''), concat('event-step:', event_id)) AS step_id,
    COALESCE(nullif(tool_call_id, ''), concat('event-call:', event_id)) AS tool_call_id,
    model,
    service_name,
    max_by(agent_type, event_time) AS agent_type,
    max_by(model_provider, event_time) AS model_provider,
    user_id,
    max_by(host_name, event_time) AS host_name,
    max_by(host_ip, event_time) AS host_ip,
    min(__time__) AS first_time,
    max(__time__) AS latest_time,
    max_by(input_messages_delta, length(coalesce(input_messages_delta, ''))) AS input_messages_delta,
    max_by(output_messages, length(coalesce(output_messages, ''))) AS output_messages,
    max_by(finish_reasons, length(coalesce(finish_reasons, ''))) AS finish_reasons,
    max(coalesce(input_tokens, 0)) AS input_tokens,
    max(coalesce(output_tokens, 0)) AS output_tokens,
    greatest(max(coalesce(total_tokens, 0)), max(coalesce(input_tokens, 0)) + max(coalesce(output_tokens, 0))) AS total_tokens,
    count(*) AS raw_event_count,
    json_format(CAST(slice(array_agg(event_id), 1, 20) AS JSON)) AS event_ids,
    json_format(CAST(slice(array_agg(event_name), 1, 20) AS JSON)) AS event_names
  FROM token_event_t t
  GROUP BY
    t.source_scope, t.user_id, t.service_name,
    COALESCE(nullif(nullif(session_id, ''), 'null'), '-'),
    COALESCE(nullif(turn_id, ''), concat('event-turn:', event_id)),
    COALESCE(nullif(step_id, ''), concat('event-step:', event_id)),
    COALESCE(nullif(tool_call_id, ''), concat('event-call:', event_id)),
    model
)
