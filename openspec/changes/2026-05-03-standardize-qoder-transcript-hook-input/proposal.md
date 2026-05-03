## Why

Qoder and Qoder CLI both invoke hooks from the shared `.qoder/settings.json`, so the hook command argument cannot reliably identify which product produced a transcript row. The existing `QoderCliInput` treats the hook stream as CLI-only and emits legacy `AgentActivityEntry` fields, which prevents consistent JSONL/SLS analysis across Qoder IDE and Qoder CLI transcript formats.

## What Changes

- Standardize the existing Qoder transcript hook input so it can consume both observed transcript schemas:
  - Qoder CLI-style rows from `raw-qoder-cli.jsonl`.
  - Qoder IDE-style rows from `raw-qoder-ide.jsonl`.
- Emit standard dotted `AgentActivityEntry` fields instead of relying on legacy `agentType` / `actionType` / `filePath` / `extra` aliases.
- Infer `agent.type` from transcript row shape, not from the hook command argument:
  - CLI-like transcript rows emit `agent.type = qoder-cli`.
  - IDE-like transcript rows emit `agent.type = qoder`.
- Preserve the current hook installation and history-log compatibility path in this change:
  - Keep the existing `qoder-aac-hook.sh` behavior and `logs/qoder-cli/history/qoder-cli-*.jsonl` channel unless a later migration explicitly renames it.
  - Keep the existing listener/input id stable for compatibility.
- Map user prompts, assistant text/thinking, tool calls, and tool results into normalized `event.name` values and standard fields.
- Ignore low-value metadata rows such as title, last-prompt, session metadata, and hook progress unless a later requirement asks to emit them.
- Reuse the existing local JSONL and SLS flusher path by emitting normalized entries from the input.

## Capabilities

### New Capabilities
- `qoder-transcript-hook-normalization`: Normalize shared Qoder transcript hook history rows from both Qoder IDE and Qoder CLI into standard `AgentActivityEntry` records.

### Modified Capabilities

## Impact

- Updates `QoderCliInput` semantics to act as the generic Qoder transcript hook mapper while keeping its compatibility-facing id/listener path.
- Updates tests and fixtures to cover both raw Qoder CLI and Qoder IDE transcript formats.
- May add helper functions for transcript row variant detection, message content extraction, tool call mapping, and tool result mapping.
- No new runtime dependency is expected; the hook processor should remain lightweight and fail-open.
