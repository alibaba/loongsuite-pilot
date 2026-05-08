## Why

The collector's current `AgentActivityEntry` shape uses a partial OTel style with shortened fields such as `session.id`, `turn.id`, `agent.type`, `cost.*`, and `tool.result.*`. The current endpoint-side Agent schema in `端侧 Agent 支持情况 (1).md` defines a different canonical reporting contract in section 3, so the OpenSpec change and implementation plan need to align with that table before code changes begin.

## What Changes

- Standardize `AgentActivityEntry` on the field definitions from section 3 of the current endpoint-side Agent schema.
- Treat OTel-style top-level fields as canonical where listed: `time_unix_nano`, `observed_time_unix_nano`, `event.*`, `user.id`, `trace_id`, `span_id`, `parent_span_id`, `host.*`, `service.name`, and `error.*`.
- Move Agent, request, response, usage, cost, tool, and skill fields into their canonical `gen_ai.*` names, including `gen_ai.turn.id`, `gen_ai.step.id`, `gen_ai.agent.*`, `gen_ai.request.id`, `gen_ai.usage.*_cost`, `gen_ai.tool.call.exec.id`, and `gen_ai.tool.call.duration`.
- Update `event.name` handling to the current enum: `llm.request`, `llm.response`, `tool.call`, `tool.result`, `skill.use`, `tool.approve`, and `other`.
- Treat the new dotted field names as the canonical output schema for JSONL, SLS, HTTP, and contract tests.
- Keep input compatibility for old local logs and existing hook/transcript records by accepting legacy aliases such as `session.id`, `turn.id`, `step.id`, `agent.type`, `request.id`, `provider.name`, `request.model`, `usage.input_tokens`, `cost.input`, `tool.exec.id`, `tool.result.duration_ms`, `input.messages`, `tool.arguments`, and `tool.result.payload`.
- Infer `gen_ai.provider.name` when raw records do not provide it, using model names and agent/source context.
- Normalize old `event.name = event` to canonical `other` for newly emitted output.
- Update sensitive content policy/redaction to operate on the current canonical sensitive field names while tolerating old aliases during migration.
- **BREAKING**: Downstream consumers of collector output must read the current canonical field names instead of old shortened names.

## Capabilities

### New Capabilities

- `agent-activity-entry-schema`: Canonical normalized AI agent activity event schema based on the current endpoint-side field table, including field naming, event enum mapping, provider inference, legacy input compatibility, sensitive-field classification, and output serialization expectations.

### Modified Capabilities

- None.

## Impact

- Affected code areas:
  - `src/types/events.ts`: Update the `AgentActivityEntry` contract and related event/provider/status types.
  - `src/normalization/entry-builder.ts`: Build canonical entries, map legacy option names to new fields, serialize canonical fields only, and infer providers.
  - `src/normalization/agent-content-policy.ts`: Apply message content capture policy to new GenAI content fields and legacy aliases.
  - Inputs under `src/inputs/**`: Emit canonical fields while reading both new and legacy raw log keys.
  - `src/core/input-manager.ts`: Continue enriching `user.id` after entries use the canonical schema.
  - Flushers under `src/flushers/**`: Preserve canonical dotted keys during output.
  - Contract, unit, and integration tests: Update assertions and fixtures for new field names plus legacy input compatibility.
- No new external dependencies are required.
