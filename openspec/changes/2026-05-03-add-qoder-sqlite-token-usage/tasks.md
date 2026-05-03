## 1. SQLite Access Setup

- [x] 1.1 Add an explicit Node SQLite dependency and matching TypeScript typings if required.
- [x] 1.2 Confirm the dependency works with the project ESM TypeScript build and Node 18 target.

## 2. Qoder SQLite Input

- [x] 2.1 Add `QoderSqliteInput` as a `BaseSqliteInput` subclass under `src/inputs/qoder-sqlite/`.
- [x] 2.2 Resolve the default Qoder database path to `SharedClientCache/cache/db/local.db`, with constructor override support for tests.
- [x] 2.3 Implement `readNewRows(lastRowId)` to query only `rowid`, `id`, `session_id`, `request_id`, `role`, `token_info`, and `gmt_create` from `chat_message`.
- [x] 2.4 Filter rows to non-empty valid `token_info` and order results by ascending `rowid` for deterministic cursor advancement.
- [x] 2.5 Implement `transformRow()` to emit `llm.response` entries with `agent.type = qoder`, no `client.channel`, and `attributes.source = qoder-sqlite-chat-message`.
- [x] 2.6 Use `gmt_create` as the source event timestamp so `time_unix_nano` reflects Qoder message creation time.
- [x] 2.7 Map `prompt_tokens`, `completion_tokens`, and `cached_tokens` to `usage.input_tokens`, `usage.output_tokens`, and `usage.cache_read_tokens`; store `max_input_tokens` in attributes.
- [x] 2.8 Exclude `model_info`, `content`, `summary`, `tool_result`, and `extra` from both SQL selection and emitted attributes.

## 3. Pipeline Registration

- [x] 3.1 Export the new input from the public input exports if needed by local project conventions.
- [x] 3.2 Register `QoderSqliteInput` in the orchestrator alongside existing Qoder inputs.
- [x] 3.3 Add listener configuration for the SQLite input while preserving emitted `agent.type = qoder`.
- [x] 3.4 Ensure availability checks fail open when the Qoder database file is missing or unreadable.
- [x] 3.5 Verify Qoder SQLite token usage entries are routed through the existing multi-flusher path for both JSONL and SLS when enabled.

## 4. Tests and Verification

- [x] 4.1 Add unit tests for token field mapping, source attributes, unset `client.channel`, and excluded fields.
- [x] 4.2 Add unit or integration coverage for rowid cursor behavior and duplicate avoidance.
- [x] 4.3 Add coverage that `gmt_create` maps to event time while observed time remains collection time.
- [x] 4.4 Add coverage for invalid or empty `token_info` handling.
- [x] 4.5 Add verification that emitted entries serialize with the existing JSONL and SLS flusher paths.
- [x] 4.6 Run typecheck and relevant tests.
