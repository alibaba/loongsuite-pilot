## Why

Qoder stores token usage for IDE chat messages in its local SQLite cache, but the collector currently does not read this source. Capturing this data lets the project measure Qoder token usage through the existing input and flusher pipeline, including JSONL and SLS outputs.

## What Changes

- Add a Qoder SQLite token usage input that reads `chat_message.token_info` from Qoder's `SharedClientCache/cache/db/local.db`.
- Reuse the existing `BaseSqliteInput` cursor pattern so collection is incremental by SQLite `rowid`.
- Collect only token usage and minimal identifiers from `chat_message`: `rowid`, `id`, `session_id`, `request_id`, `role`, `token_info`, and `gmt_create`.
- Do not collect `model_info`, `content`, `summary`, `tool_result`, or `extra`.
- Keep emitted `agent.type` as `qoder` and mark the raw source with `attributes.source`.
- Use `chat_message.gmt_create` as the source event timestamp for emitted entries.
- Map Qoder token fields to collector usage fields:
  - `prompt_tokens` to `usage.input_tokens`
  - `completion_tokens` to `usage.output_tokens`
  - `cached_tokens` to `usage.cache_read_tokens`
  - `max_input_tokens` to `attributes.max_input_tokens`
- Send emitted entries through the existing flusher pipeline so both JSONL and SLS flushers can receive the same normalized token usage entries.
- Add an explicit Node SQLite dependency rather than relying on a user-installed `sqlite3` command-line tool.

## Capabilities

### New Capabilities

- `qoder-sqlite-token-usage`: Collect Qoder token usage from the local SQLite chat cache and emit normalized usage entries through the collector pipeline.

### Modified Capabilities

- None.

## Impact

- Adds a new Qoder SQLite input implementation under `src/inputs`.
- Registers the new input with the orchestrator and listener configuration.
- Adds a SQLite runtime dependency for reading local Qoder databases.
- Extends tests to cover row querying, token mapping, skipped fields, and compatibility with the existing JSONL/SLS flusher pipeline.
