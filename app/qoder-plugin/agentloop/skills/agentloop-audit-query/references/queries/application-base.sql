-- CTE fragment: replace integer {{from}} / {{to}}, then append SELECT.
WITH event_raw AS (
  SELECT __time__ AS ts, "event.id" AS event_id, "event.name" AS raw_event_name,
    "user.id" AS user_id, "gen_ai.session.id" AS session_id,
    "gen_ai.turn.id" AS turn_id, "gen_ai.step.id" AS step_id,
    "gen_ai.tool.call.id" AS tool_call_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.agent.id" AS agent_id, "gen_ai.provider.name" AS provider,
    coalesce(nullif(nullif("__tag__:__service_name__", ''), 'null'),
      nullif(nullif("service.name", ''), 'null')) AS service_name,
    coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'),
      nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model,
    "gen_ai.tool.name" AS tool_name,
    "error.type" AS error_type, "error.message" AS error_message,
    try_cast("gen_ai.usage.input_tokens" AS bigint) AS input_tokens,
    try_cast("gen_ai.usage.output_tokens" AS bigint) AS output_tokens,
    try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) AS cache_read_tokens
  FROM "agent-event" WHERE __time__ >= {{from}} AND __time__ < {{to}}
  UNION ALL
  SELECT __time__ AS ts, "event.id" AS event_id, "event.name" AS raw_event_name,
    "user.id" AS user_id, "gen_ai.session.id" AS session_id,
    "gen_ai.turn.id" AS turn_id, "gen_ai.step.id" AS step_id,
    "gen_ai.tool.call.id" AS tool_call_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.agent.id" AS agent_id, "gen_ai.provider.name" AS provider,
    coalesce(nullif(nullif("__tag__:__service_name__", ''), 'null'),
      nullif(nullif("service.name", ''), 'null')) AS service_name,
    coalesce(nullif(nullif("gen_ai.response.model", ''), 'null'),
      nullif(nullif("gen_ai.request.model", ''), 'null'), 'unknown') AS model,
    "gen_ai.tool.name" AS tool_name,
    "error.type" AS error_type, "error.message" AS error_message,
    try_cast("gen_ai.usage.input_tokens" AS bigint) AS input_tokens,
    try_cast("gen_ai.usage.output_tokens" AS bigint) AS output_tokens,
    try_cast("gen_ai.usage.cache_read.input_tokens" AS bigint) AS cache_read_tokens
  FROM "agent-event-webtracking" WHERE __time__ >= {{from}} AND __time__ < {{to}}
), event_base AS (
  SELECT ts, event_id,
    CASE raw_event_name
      WHEN 'llm.request' THEN 'gen_ai.model.request'
      WHEN 'llm.response' THEN 'gen_ai.model.response'
      WHEN 'tool.call' THEN 'gen_ai.tool.call'
      WHEN 'tool.result' THEN 'gen_ai.tool.result'
      ELSE raw_event_name END AS event_name,
    'application' AS source_scope,
    nullif(nullif(user_id, ''), 'null') AS user_id,
    nullif(nullif(session_id, ''), 'null') AS session_id,
    nullif(nullif(turn_id, ''), 'null') AS turn_id,
    nullif(nullif(step_id, ''), 'null') AS step_id,
    tool_call_id, agent_id, service_name,
    coalesce(nullif(nullif(agent_type, ''), 'null'), 'unknown') AS agent_type,
    coalesce(nullif(nullif(provider, ''), 'null'), 'unknown') AS provider,
    model, tool_name, error_type, error_message,
    input_tokens, output_tokens, cache_read_tokens
  FROM event_raw
), usage_events AS (
  SELECT *, coalesce(input_tokens, 0) + coalesce(output_tokens, 0) AS observed_tokens,
    input_tokens > 0 AND cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens AS cache_valid
  FROM event_base WHERE event_name = 'gen_ai.model.response'
)
