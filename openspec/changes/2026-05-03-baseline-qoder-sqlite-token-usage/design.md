## Context

`QoderSqliteInput` extends `BaseSqliteInput`, which reads rows using the persisted `lastRowId` cursor. When `lastRowId` is absent, the base class defaults to `0`, so a fresh AAC install or deleted `~/.ai-agent-collector/logs/input-state.json` causes `qoder-sqlite` to query every historical eligible `chat_message` row.

For Qoder SQLite token usage, historical backfill is not desired. The input should behave like a live collector: establish a high-water mark on first start and only emit token usage rows created after the collector is running.

## Goals / Non-Goals

**Goals:**
- Prevent historical Qoder SQLite token usage replay when AAC state is missing.
- Preserve normal incremental behavior when `qoder-sqlite` state already exists.
- Continue emitting new eligible rows inserted after startup.
- Keep the baseline scoped to `QoderSqliteInput`; do not change all SQLite inputs globally.

**Non-Goals:**
- Do not delete or rewrite existing Qoder SQLite database rows.
- Do not backfill old rows through a migration path.
- Do not change token field mapping or SLS/JSONL flusher behavior.

## Decisions

### Baseline on input start when no cursor exists

`QoderSqliteInput` should override `onStart()` and inspect its current state. If the input has no persisted rowid cursor, it should query the maximum eligible `chat_message.rowid` and set that as the cursor before the first collection cycle runs.

This works with `BaseInput.start()` because `onStart()` runs before `runCycle()`.

Alternative considered: modify `BaseSqliteInput` to support baseline mode generically. That would affect all SQLite inputs and requires more design; the current requirement is specific to Qoder SQLite token usage.

### Baseline only eligible token rows

The maximum baseline rowid should be computed using the same eligibility filters as normal collection:

- `token_info IS NOT NULL`
- `token_info != ''`
- `json_valid(token_info)`

This prevents invalid/irrelevant rows from unnecessarily advancing the cursor past relevant future rows only if SQLite row ordering is unexpected.

### Preserve existing state

If `lastRowId` already exists in the state store, startup must not overwrite it. This allows normal restarts to resume from the last collected rowid and collect rows that arrived while the service was stopped.

### Handle empty or unavailable DB safely

If no eligible rows exist, baseline to `0` or leave state effectively unchanged. If the DB cannot be opened, startup should remain fail-open and allow later availability checks/polls to retry.

## Risks / Trade-offs

- Deleting AAC state intentionally discards the ability to recover missed rows -> This matches the requested no-history behavior.
- Rows inserted between baseline query and first poll should still be collected if their rowid is greater than the baseline -> The next collection cycle queries `rowid > baseline`.
- Using eligible max rowid means invalid historical rows may not be represented in state -> They are out of scope for token usage collection.

## Migration Plan

1. Add a Qoder-specific max eligible rowid query.
2. Override `QoderSqliteInput.onStart()` to baseline only when state lacks `lastRowId`.
3. Add tests for fresh state, existing state, empty DB, and new rows after baseline.
4. Run Qoder SQLite tests, typecheck, lints, and the full suite.

## Open Questions

- Should future config allow an explicit historical backfill mode for Qoder SQLite? Current scope says no.
