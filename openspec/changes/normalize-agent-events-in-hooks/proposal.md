## Why

Hook history logs are currently treated mostly as raw source payloads, so Cursor and Qoder-specific event normalization lives inside `BaseHookInput` subclasses. Moving the source-specific mapping closer to the hook boundary makes the JSONL history itself standard-compatible, easier to replay, and less dependent on duplicated input-side parsing.

## What Changes

- Emit standard-compatible AI agent event records from asset hook processors for Cursor and Qoder-family hooks where source payloads contain enough context.
- Add shared asset-side normalization helpers so Cursor and Qoder hook processors reuse common event mapping logic.
- Keep `BaseHookInput` subclasses responsible for tailing, checkpoints, final `buildAgentActivityEntry()` validation/building, and collector emission.
- Update hook inputs to prefer canonical dotted keys from hook JSONL and keep legacy raw/transcript parsing only as fallback during migration.
- Duplicate selected collector enrichment/policy logic in hook processors where practical, including `user.id` defaults, provider fallback, and content-policy filtering, while keeping collector-side final enforcement authoritative.
- Define which fields must still remain input-side because they require cross-record state, runtime enrichment, or final schema cleanup.
- Add focused tests for processor output contracts, input fallback compatibility, and replay semantics.

## Capabilities

### New Capabilities
- `hook-standard-event-records`: Defines the contract for asset hook processors to write standard-compatible AI agent event JSONL records while preserving replay and fail-open behavior.

### Modified Capabilities
- None. There are no existing OpenSpec capability specs to modify.

## Impact

- Affected baseline modules: `hooks`, `normalization`, `types`, and `core` orchestration boundaries.
- Affected code areas: `assets/hooks/*processor.mjs`, `assets/hooks/*-loongsuite-pilot-hook.sh`, `src/inputs/base/base-hook-input.ts`, `src/inputs/cursor-hook/cursor-hook-input.ts`, `src/inputs/qoder-cli/qoder-cli-input.ts`, `src/hooks/hook-manager.ts`, and related unit/integration tests.
- No new external dependencies are expected.

## Baseline Documentation Updates

- Update `specs/baseline/modules/hooks.md` to document the shared asset-side normalizer/helper and the stronger rule that deterministic per-event normalization from hook stdin/transcripts belongs in `assets/hooks/*.mjs` by default.
- Update `specs/baseline/modules/normalization.md` to clarify that hook-side pre-standardization may duplicate user defaulting, provider fallback, and content-policy filtering, while collector normalization remains responsible for final `AgentActivityEntry` building, alias cleanup, and authoritative policy enforcement.
- No baseline architecture violation is proposed: hook processors still write append-only local history/error/debug files only, and normalized entries still flow through Input -> InputManager -> Flusher.
