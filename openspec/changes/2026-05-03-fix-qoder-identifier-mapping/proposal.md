## Why

The current Qoder mappings over-populate identifier fields by treating Qoder CLI segment `turn_id` / `loop_id` as canonical turn/step identifiers and by storing Qoder CLI segment `request_id` under standard id fields. These fields are semantically misleading for downstream JSONL/SLS analysis; unsupported request/response/turn/step identifiers should be omitted rather than synthesized.

## What Changes

- Correct Qoder CLI session segment token usage mapping:
  - Do not emit `turn.id` from segment `turn_id`.
  - Do not emit `step.id` from segment `loop_id`.
  - Do not emit `request.id` or `response.id` from segment `request_id`; preserve it in `attributes` only.
- Correct Qoder transcript hook mapping:
  - Map assistant transcript `message.id` / `attributes.message_id` to `response.id` for assistant response rows.
  - Do not emit `request.id` for Qoder IDE (`agent.type = qoder`) transcript rows.
  - Continue leaving CLI transcript `turn.id` empty unless a future canonical turn id is identified.
- Correct Qoder SQLite token usage mapping:
  - Do not emit `request.id` from `chat_message.request_id`; preserve it in `attributes` only.
- Update tests and specs so identifier fields are only populated when their semantics are known.

## Capabilities

### New Capabilities
- `qoder-identifier-mapping`: Define correct request/response/turn/step identifier semantics for Qoder CLI session segments and Qoder transcript hook rows.

### Modified Capabilities

## Impact

- Updates `QoderCliSessionInput` field mapping for token usage events.
- Updates `QoderCliInput` field mapping for transcript-derived assistant responses.
- Updates `QoderSqliteInput` field mapping for SQLite token usage events.
- Updates Qoder-related unit/integration tests and OpenSpec expectations.
- No hook installation or processor behavior changes are expected.
