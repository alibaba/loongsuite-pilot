## Context

Qoder IDE and Qoder CLI share `.qoder/settings.json` hook configuration. The installed Stop hook currently invokes `qoder-loongsuite-pilot-hook.sh qoder-cli`, but that argument only controls the collector's local history directory and file prefix; it cannot reliably identify whether the raw transcript row came from Qoder IDE or Qoder CLI.

The current `hook-processor.mjs` reads incremental transcript lines and copies them into `~/.loongsuite-pilot/logs/qoder-cli/history/qoder-cli-YYYY-MM-DD.jsonl`. The current `QoderCliInput` then consumes those rows, but it treats the stream as CLI-only and uses legacy `buildAgentActivityEntry` options. Observed transcript fixtures show at least two schemas:

- CLI-style rows: include `entrypoint: "cli"`, `promptId`, `parentUuid`, `permissionMode`, `userType`, and Claude-like content blocks.
- IDE-style rows: include `session_meta` / `progress` rows and message content blocks without `entrypoint`.

## Goals / Non-Goals

**Goals:**
- Normalize both observed Qoder transcript schemas into standard dotted `AgentActivityEntry` fields.
- Infer `agent.type` from row shape, not from the hook command argument.
- Preserve existing hook installation, listener id, state key behavior, and `logs/qoder-cli/history` compatibility for this change.
- Keep hook execution fail-open and lightweight.
- Ignore low-value transcript metadata rows by default.

**Non-Goals:**
- Do not rename the installed hook command, listener key, history directory, or class/module in this change unless required for correctness.
- Do not make `hook-processor.mjs` perform semantic `AgentActivityEntry` mapping.
- Do not emit token usage from transcript rows; token usage remains covered by the Qoder CLI session segment and SQLite inputs.
- Do not emit multiple entries from one transcript row in the first implementation.

## Decisions

### Keep the hook processor as a transcript forwarder

`hook-processor.mjs` should remain responsible for reading incremental transcript lines and appending raw JSON rows to history files. Semantic mapping belongs in the TypeScript input where it is easier to test and shares existing normalization helpers.

Alternative considered: emit full `AgentActivityEntry` records directly from the processor. That would duplicate normalization logic in a hook-time script and make fail-open behavior riskier.

### Keep compatibility names for now

This change should keep the existing `qoder-cli-hook` listener id and `logs/qoder-cli/history/qoder-cli-*.jsonl` history path. Although the names are imperfect, changing them would create a migration concern for state offsets, hook installation checks, and existing local logs.

Alternative considered: rename the input to `qoder-transcript-hook` and move logs to `logs/qoder-transcript/history`. That is conceptually cleaner but should be handled as a separate migration after the mapper is stable.

### Infer row variant in the input

The input should infer a row variant before mapping:

- `qoder-cli` when the row has `entrypoint: "cli"` or CLI-only fields such as `promptId`, `permissionMode`, or `userType`.
- `qoder` when the row has IDE metadata/progress types or lacks CLI-only markers.
- `unknown` may be used only internally; emitted supported rows should choose `qoder` as the safe default if the row is not CLI-like.

Alternative considered: trust the hook command argument. This fails because both Qoder IDE and Qoder CLI can use the same `.qoder/settings.json` hook command.

### Emit one normalized entry per supported row

The first implementation should keep `BaseHookInput` unchanged and emit at most one `AgentActivityEntry` per raw transcript row. If a message row has multiple content blocks, the mapper should choose the dominant event:

- Any `tool_result` block maps to `tool.result`.
- Any `tool_use` block maps to `tool.call`.
- Assistant text/thinking maps to `llm.response`.
- User text maps to `llm.request`.

Alternative considered: allow one raw row to emit multiple entries. That improves fidelity for multi-block rows but expands the `BaseHookInput` contract and downstream tests.

### Map standard event fields

Supported rows should use standard fields:

- `event.id` from raw `uuid` when present.
- `event.name` as `llm.request`, `llm.response`, `tool.call`, or `tool.result`.
- `session.id` from `sessionId` / `session_id` / `conversation_id`.
- `turn.id` is not emitted for CLI-like transcript rows because observed CLI `promptId` / `turn_id` values do not represent the canonical turn identity; non-CLI rows may use an explicit `turn_id` if one appears.
- `agent.type` from inferred variant: `qoder-cli` or `qoder`.
- `message.role`, `request.model`, `response.model`, `response.finish_reasons`, `input.messages_delta`, `output.messages`, `tool.name`, `tool.call.id`, `tool.arguments`, `tool.result.payload`, `tool.result.status`, and `is_error` where available.
- `attributes.source = qoder-transcript-hook`, plus variant, cwd, entrypoint, parent ids, transcript metadata, and raw type for diagnostics.

### Ignore metadata rows by default

Rows such as `session_meta`, `progress`, `ai-title`, and `last-prompt` should not emit `AgentActivityEntry` records in the first version. They are useful for debugging but low value for SLS analytics compared with prompt, response, tool call, and tool result rows.

## Risks / Trade-offs

- Transcript schemas may evolve -> Keep mapping tolerant, preserve raw type/variant metadata in attributes, and cover observed fixtures in tests.
- Compatibility names remain misleading -> Document that `qoder-cli-hook` is a compatibility channel, not proof of `agent.type`.
- One-row-one-entry loses fidelity for multi-block messages -> Start conservative; consider array-emitting hook inputs later if needed.
- Variant detection is heuristic -> Prefer explicit row fields where available and add tests using both raw fixtures.

## Migration Plan

1. Update mapper behavior behind the existing listener id and history path.
2. Keep current state offsets and hook installation paths compatible.
3. Validate with unit tests using `raw-qoder-cli.jsonl` and `raw-qoder-ide.jsonl`.
4. Defer any rename from `qoder-cli-hook` to `qoder-transcript-hook` to a separate change.

## Open Questions

- Should future work split multi-content transcript rows into multiple entries by expanding `BaseHookInput` to support arrays?
- Should a later migration rename the compatibility channel from `qoder-cli-hook` to `qoder-transcript-hook`?
