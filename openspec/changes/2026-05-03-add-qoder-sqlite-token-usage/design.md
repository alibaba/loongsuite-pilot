## Context

The collector already has a `BaseSqliteInput` abstraction for incremental SQLite polling, but no concrete SQLite input currently uses it. Qoder IDE stores chat message metadata in `SharedClientCache/cache/db/local.db`, and the `chat_message.token_info` column contains token usage as a JSON string.

The first implementation should focus only on token usage. It must avoid message body and internal metadata columns that are not needed for usage reporting, including `content`, `summary`, `tool_result`, `extra`, and `model_info`.

## Goals / Non-Goals

**Goals:**

- Add `QoderSqliteInput` as a concrete `BaseSqliteInput` subclass.
- Read Qoder's local SQLite database using an explicit Node dependency rather than the system `sqlite3` command.
- Incrementally collect rows from `chat_message` where `token_info` is present and valid.
- Emit `AgentActivityEntry` records with `agent.type` set to `qoder`.
- Use `chat_message.gmt_create` as the source event timestamp.
- Map token usage into the existing usage fields so current JSONL and SLS flushing work without a new flusher.

**Non-Goals:**

- Do not collect Qoder message content, summaries, tool results, `extra`, or model metadata.
- Do not standardize cost calculation or model pricing.
- Do not report to SLS directly from the Qoder SQLite input; SLS delivery must happen through the existing flusher pipeline.
- Do not change existing Qoder history or ai_tracker collection behavior.

## Decisions

1. Use `QoderSqliteInput` as a new input alongside the existing `QoderInput`.

   Rationale: the existing `QoderInput` collects file history and ai_tracker JSONL data. Token usage from `chat_message` is a separate source with a different cursor model, so a dedicated SQLite input keeps concerns isolated while preserving `agent.type = qoder`.

   Alternative considered: extend `QoderInput` directly. This would mix filesystem snapshot polling with database polling and make the existing class harder to test.

2. Reuse `BaseSqliteInput` rowid cursor tracking.

   Rationale: `BaseSqliteInput` already reads `lastRowId`, calls `readNewRows(lastRowId)`, transforms rows, and persists the max observed `rowid`. Qoder's `chat_message` table can be queried with SQLite's hidden `rowid`, making it suitable for this cursor pattern.

   Alternative considered: cursor by `gmt_create`. Timestamps can collide or move backward if records are inserted with older times, while `rowid` is monotonic for appended rows.

3. Add an explicit SQLite package dependency.

   Rationale: the collector is intended to run on other machines, so relying on a preinstalled `sqlite3` CLI would create an implicit runtime requirement. A Node dependency makes the requirement visible in `package.json`.

   Alternative considered: call the system `sqlite3` command. This is useful for local exploration but not appropriate for packaged collection.

4. Emit normalized usage fields and keep Qoder-specific details in attributes.

   Rationale: `AgentActivityEntry` already has `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_tokens`, and `usage.total_tokens`. `max_input_tokens` is useful context but not a standard usage metric, so it belongs in `attributes`.

   Mapping:

   - `prompt_tokens` -> `usage.input_tokens`
   - `completion_tokens` -> `usage.output_tokens`
   - `cached_tokens` -> `usage.cache_read_tokens`
   - `prompt_tokens + completion_tokens` -> `usage.total_tokens`
   - `max_input_tokens` -> `attributes.max_input_tokens`

5. Map `gmt_create` to the event timestamp.

   Rationale: `chat_message.gmt_create` is stored as Unix epoch milliseconds. Passing it as the entry timestamp lets `buildAgentActivityEntry` populate `time_unix_nano` from the original Qoder message time, while `observed_time_unix_nano` still reflects collector observation time.

   Alternative considered: use collection time. This would lose the actual Qoder message timing and make historical backfill inaccurate.

6. Do not set `client.channel`.

   Rationale: the source is sufficiently identified by `attributes.source = qoder-sqlite-chat-message`, and the user requested that `client.channel` remain unset.

7. Use the existing multi-flusher pipeline for JSONL and SLS.

   Rationale: the orchestrator already builds configured flushers and routes input entries through the input manager. Qoder SQLite token usage should emit normal `AgentActivityEntry` records so JSONL and SLS receive the same data shape.

   Alternative considered: report Qoder token usage directly to SLS from the input. This would duplicate routing logic and make the input responsible for output concerns.

## Risks / Trade-offs

- Qoder database path changes -> Keep path resolution centralized and allow constructor override in tests.
- SQLite database is locked or temporarily unavailable -> Treat read failures as non-fatal and rely on the next polling cycle.
- `token_info` contains malformed JSON -> Skip the row or emit a warning without advancing beyond successfully observed row processing behavior defined by `BaseSqliteInput`.
- Multiple Qoder inputs emit `agent.type = qoder` -> Use `attributes.source` to distinguish SQLite token usage from history and ai_tracker events.
- SLS serialization drops unexpected fields -> Use existing `AgentActivityEntry` usage fields and JSON-safe attributes so current SLS serialization can preserve token usage.
- Native SQLite dependency installation can fail on unsupported platforms -> Select a maintained package with Node 18 support and cover install expectations in implementation notes if needed.
