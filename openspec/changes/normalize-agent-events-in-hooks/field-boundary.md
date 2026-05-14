## Field Boundary Inventory

### Cursor Hook Payload

Hook-owned by default:
- Source event name: `hook_event_name`, `hookEventName`, `hookEvent`, `hookEvent` wrappers -> `event.name`.
- Event identity/time: `event.id`, `time_unix_nano`, `timestamp`, hook observed time -> `event.id`, `time_unix_nano`, `observed_time_unix_nano`.
- Session/turn/step identifiers: `session_id`, `conversation_id`, `session.id`, `generation_id`, `turn_id`, `step_id`.
- Agent/model/provider: `gen_ai.agent.type`, `model`, explicit provider fields.
- Usage/cost/finish reason: token and cost fields already present in stdin.
- Messages/tools/errors: prompt/text/message deltas, tool input/output/result, tool status/duration, explicit error fields.

Duplicated in hook and collector:
- `user.id`: hook applies payload/env/config/hostname defaulting; collector may override with configured user.
- `gen_ai.provider.name`: hook infers from explicit provider/model/agent; collector re-applies final fallback.
- Content policy: hook filters message/tool content before history write; collector re-applies policy after input.

Collector-owned:
- Checkpoint offsets, final schema cleanup, alias cleanup, authoritative content policy, git/workspace/host enrichment, trace tree construction, and cross-record correlation.

Legacy fallback-only:
- Raw Cursor payload fields without canonical equivalents remain available through `agent.cursor.*` while fallback parsing exists. Converted source keys are not duplicated.

### Qoder Transcript and Hook Payloads

Hook-owned by default:
- Transcript row kind/content block -> `event.name`.
- Row `uuid`/timestamp/session IDs -> `event.id`, `time_unix_nano`, `gen_ai.session.id`.
- Variant inference from `entrypoint`, `permissionMode`, `userType`, and related markers -> `gen_ai.agent.type`.
- Message model/response id/finish reason -> `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`.
- Tool blocks and tool results -> `gen_ai.tool.*`, `tool.result.status`.
- Legacy `PostToolUse` hook payloads -> canonical `tool.result` records.

Duplicated in hook and collector:
- `user.id`, provider fallback, and content policy use the same best-effort hook strategy with collector-side authoritative re-application.

Technically unavailable from single hook input:
- Missing turn/step IDs when the source row does not include enough linkage.
- Parent/child span relationships and accurate cross-event request/response pairing.
- Missing token/cost values when the source did not emit them.

Technically possible but collector-owned for architecture consistency:
- Reading git metadata, host/network data, broader workspace state, and maintaining replay/checkpoint state.
