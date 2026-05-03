## Context

The collector already has a shared input lifecycle (`BaseInput`), a session-file polling base (`BaseSessionInput`), an input registry (`InputManager`/orchestrator), and fan-out flushers for local JSONL and SLS. Existing Qoder-related inputs cover IDE history, SQLite token data, and hook-generated Qoder CLI logs, but they do not consume Qoder CLI's native session segment files.

Qoder CLI writes JSONL segment files below `~/.qoder/logs/sessions/<cwd-key>/<session-id>/segments/*.jsonl`. The token-relevant records observed in these files are `model.response.completed` events with request ids, turn ids, model names, stop reasons, and token usage counters. The session id is not present in those JSON rows, but the enclosing `<session-id>` directory is stable and should be used as `session.id`.

## Goals / Non-Goals

**Goals:**
- Collect token usage from Qoder CLI native segment files without requiring hook injection.
- Avoid startup backfill of historical Qoder segment data.
- Continue capturing segment files created while the collector is running, including their initial contents.
- Emit normalized `AgentActivityEntry` records that flow through the existing JSONL and SLS flushers.
- Keep the first version narrowly focused on token usage and ignore unrelated Qoder event types.

**Non-Goals:**
- Do not reconstruct complete conversations or assistant text from Qoder sessions.
- Do not process every Qoder segment event type.
- Do not add content redaction or privacy filtering in this change.
- Do not replace the existing `qoder-cli-hook` input; the new input is a separate source using `agent.type = qoder-cli`.

## Decisions

### Add a separate session input

Create a new Qoder CLI session input based on `BaseSessionInput` instead of modifying the existing hook input. This keeps source semantics clear: hook JSONL remains hook-generated telemetry, while the new input reads Qoder's native session files.

Alternative considered: extend `QoderCliInput` to also read native session segments. That would mix two collection methods and two state models in one input, making listener configuration and debugging harder.

### Discover only segment JSONL files

The input should discover files matching `~/.qoder/logs/sessions/**/segments/*.jsonl`. The implementation should avoid broad scans of unrelated JSONL files in the session tree.

Alternative considered: recursively process all JSONL files under `sessions`. This is simpler but risks ingesting future Qoder metadata files that do not have the expected schema.

### Baseline existing files on startup

On startup, the input should enumerate existing segment files and set their offsets to the current file size before normal polling begins. This avoids historical backfill. After startup, newly discovered segment files should be read from offset 0 so sessions created while the collector is running are not missed.

Alternative considered: always read new-to-state files from the end. That strictly avoids all old data but can miss the first records of a segment file created after the collector starts.

### Process only `model.response.completed`

The first version should map only `model.response.completed` rows because they contain the token usage fields this feature needs. Other event types should return `null` from `processSessionLine`.

Alternative considered: also process `turn.finished` for turn-level totals. That risks double-counting token usage because `turn.finished` aggregates one or more model responses.

### Use path-derived session ids

For a segment path shaped as `<session-root>/<cwd-key>/<session-id>/segments/<file>.jsonl`, derive `session.id` from the directory immediately above `segments`. Preserve the cwd key and source segment path in attributes for debugging.

Alternative considered: leave `session.id` empty when it is absent from the record. That loses an important join key across requests in the same Qoder session.

### Generate deterministic event ids

Generate `event.id` from stable source fields such as absolute segment path, `seq`, Qoder event type, and `request_id`. This makes replay behavior and duplicate investigation easier than using random UUIDs for each read.

Alternative considered: use `buildAgentActivityEntry` defaults. That is simpler but produces a new random id if the same source row is ever replayed.

## Risks / Trade-offs

- Qoder may change the native segment schema -> Keep unknown types ignored and preserve source metadata in attributes for supported rows.
- Startup baseline requires extra state initialization -> Keep the logic local to the new input and cover it with tests for existing versus newly created files.
- Directory scans may grow with many historical sessions -> Restrict discovery to `segments/*.jsonl` and keep the polling interval configurable.
- `agent.type = qoder-cli` differs from existing `qoder-cli-hook` -> This improves source clarity but may require dashboards to include both agent types when comparing all Qoder CLI activity.
