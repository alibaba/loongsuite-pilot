-- Query CTE: bind integer {{from}} / {{to}}, then append SELECT.
-- For relative dashboards, adapt time predicates per ../sql-writing.md.
WITH guardrail_events AS (
  SELECT __time__ AS ts, "event.id" AS event_id,
    "user.id" AS user_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.session.id" AS session_id,
    "gen_ai.guardrail.triggered" AS triggered, "gen_ai.guardrail.action" AS action
  FROM "agent-event" WHERE __time__ >= {{from}} AND __time__ < {{to}}
  UNION ALL
  SELECT __time__ AS ts, "event.id" AS event_id,
    "user.id" AS user_id, "gen_ai.agent.type" AS agent_type,
    "gen_ai.session.id" AS session_id,
    "gen_ai.guardrail.triggered" AS triggered, "gen_ai.guardrail.action" AS action
  FROM "agent-event-webtracking" WHERE __time__ >= {{from}} AND __time__ < {{to}}
)
