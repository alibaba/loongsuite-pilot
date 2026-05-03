## Why

Qoder CLI writes native session segment logs under `~/.qoder/logs/sessions/**/segments/*.jsonl`, and those logs contain the most reliable token usage telemetry for CLI runs. The collector should ingest these token usage records directly so local JSONL output and SLS reporting include Qoder CLI usage even when hook-based logs are incomplete or unavailable.

## What Changes

- Add collection of Qoder CLI native session segment JSONL files from `~/.qoder/logs/sessions/**/segments/*.jsonl`.
- Process only token-relevant records, initially `model.response.completed`; unrelated or hard-to-map event types are ignored.
- Map token usage records into `AgentActivityEntry` using `agent.type = qoder-cli`.
- Derive `session.id` from the session UUID directory immediately above `segments`.
- Avoid historical backfill on service startup by baselining existing segment files at their current byte offsets; segment files discovered after startup are read from the beginning.
- Generate deterministic `event.id` values from stable source fields such as segment path, sequence number, event type, and request id.
- Reuse the existing InputManager and configured JSONL/SLS flushers for output.

## Capabilities

### New Capabilities
- `qoder-cli-session-token-usage`: Collect Qoder CLI token usage from native session segment JSONL logs and emit normalized `AgentActivityEntry` records.

### Modified Capabilities

## Impact

- Adds a new built-in session-file input for Qoder CLI session logs.
- Updates input registration and listener defaults so the new input can be discovered, enabled, and polled.
- Adds tests for segment file discovery, startup baseline behavior, session id extraction, deterministic event ids, and token usage field mapping.
- No new runtime dependency is expected; implementation should use Node.js filesystem APIs and existing collector normalization/flusher infrastructure.
