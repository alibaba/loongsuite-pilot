## Context

LoongSuite Pilot hook processors write daily-rotated JSONL files under `~/.loongsuite-pilot/logs/` subdirectories. The collector inputs (all `BaseHookInput` subclasses) only tail today's file via byte offset — older daily files are never read again. These files accumulate indefinitely.

`hook-processor.mjs` also writes two single-file logs (`{agentId}_hook.log`, `hook_processor_error.log`) directly in `HOOKS_DIR` that grow without bound.

The orchestrator already manages global periodic work via `AgentDiscoveryService` (setInterval-based). Adding a second dedicated interval for log retention follows the same pattern.

## Goals / Non-Goals

**Goals:**

- Delete old dated log files (`*-YYYY-MM-DD.jsonl`, `*-YYYY-MM-DD.log`) across all `dataDir/logs/` subdirectories after a configurable retention period.
- Support per-category retention: hook history, hook errors, hook debug, collector output, and SLS failed logs.
- Provide a single environment variable override (`LOONGSUITE_PILOT_LOG_RETENTION_DAYS`) for unified control plus granular env vars per category.
- Convert `hook-processor.mjs` debug/error logs to daily files so they are covered by the same retention policy.
- Never delete today's files.
- Fail-open: retention errors must not crash the orchestrator or block collection.

**Non-Goals:**

- Size-based retention (e.g. max total MB) — not needed for MVP; daily file count is sufficient.
- Compressing old files before deletion.
- Cleaning up logs written outside `dataDir/logs/` (e.g. `$TMPDIR` fallback paths in `cursor-hook-processor.mjs`).
- Modifying `cursor-hook-processor.mjs` error log paths (already uses daily files under `dataDir`).

## Decisions

### Decision 1: LogRetentionService as orchestrator-owned setInterval

The orchestrator starts a `LogRetentionService` after `AgentDiscoveryService.start()`. It runs cleanup on a configurable interval (default: 6 hours). On `stop()`, the interval is cleared.

The service runs one initial cleanup at startup (after a short delay to avoid startup contention), then periodically.

Alternative considered: per-input cleanup in `BaseHookInput.collect()`. Rejected because it scatters policy across N subclasses, cannot cover error/debug/output directories, and adds FS churn to the 30-second poll cycle.

### Decision 2: Date extraction from filenames

All target files follow the pattern `*-YYYY-MM-DD.{jsonl,log}` or `*-YYYY-MM-DD.jsonl`. The service extracts the date using regex `/(\d{4}-\d{2}-\d{2})\.\w+$/` on each filename.

Files that don't match the pattern are ignored (e.g. `input-state.json`, `.line_records.*.json`).

Today's date is always excluded from deletion regardless of retention config, as a safety measure.

### Decision 3: Scan scope — recursive walk under dataDir/logs

The service recursively walks `dataDir/logs/` and applies retention rules based on the parent directory structure:

| Directory pattern | Category | Default retention |
|---|---|---|
| `logs/*/history/` | hookHistory | 30 days |
| `logs/*/errors/` | hookErrors | 14 days |
| `logs/*/debug/` | hookDebug | 7 days |
| `logs/output/` | output | 30 days |
| `logs/sls-failed-logs/` | slsFailed | 30 days |

Unrecognized subdirectories under `logs/` are skipped (not cleaned).

### Decision 4: Config schema

Extend `AnalyticsConfig` in `src/types/index.ts`:

```typescript
export interface LogRetentionConfig {
  enabled: boolean;
  intervalMs: number;
  hookHistoryDays: number;
  hookErrorDays: number;
  hookDebugDays: number;
  outputDays: number;
  slsFailedDays: number;
}
```

Extend `ConfigFile` in `config-loader.ts`:

```typescript
retention?: {
  enabled?: boolean;
  intervalMs?: number;
  hookHistoryDays?: number;
  hookErrorDays?: number;
  hookDebugDays?: number;
  outputDays?: number;
  slsFailedDays?: number;
};
```

Environment variable mapping:

| Env var | Maps to | Notes |
|---|---|---|
| `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` | All `*Days` fields | Unified override |
| `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` | `enabled` | Default: true |
| `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` | `intervalMs` | Default: 21600000 (6h) |

When `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` is set, it overrides all category-specific defaults unless a more specific config file value exists.

### Decision 5: hook-processor.mjs log migration

Change `hook-processor.mjs` to write debug and error logs as daily files:

| Before | After |
|---|---|
| `{HOOKS_DIR}/{agentId}_hook.log` | `{dataDir}/logs/{agentId}/debug/{agentId}-debug-YYYY-MM-DD.log` |
| `{HOOKS_DIR}/hook_processor_error.log` | `{dataDir}/logs/{agentId}/errors/{agentId}-error-YYYY-MM-DD.log` |

The `dataDir` is resolved from `LOONGSUITE_PILOT_DATA_DIR` env var or defaults to `~/.loongsuite-pilot`, same as the existing `LOONGSUITE_PILOT_LOGS_BASE_DIR` logic already in the file.

This makes all hook-processor output live under `dataDir/logs/` and follow the `*-YYYY-MM-DD.*` naming convention.

### Decision 6: Startup delay and error handling

The first cleanup runs 30 seconds after orchestrator start to avoid competing with input startup I/O. Subsequent runs follow the configured interval.

All cleanup errors are logged at `warn` level and swallowed. A single file deletion failure does not abort the scan. The service reports total files deleted and any errors in a single summary log line per run.

## Risks / Trade-offs

- Deleting files that haven't been consumed yet: mitigated by the 30-day default and the fact that `BaseHookInput` only reads today's file — if the collector hasn't consumed a file within 30 days, it never will.
- Race with hook processor writing: the retention service only deletes files with dates older than the cutoff, never today's. Hook processors only write to today's file. No race.
- `hook-processor.mjs` log migration creates a one-time "orphan" of old `{agentId}_hook.log` and `hook_processor_error.log` files in HOOKS_DIR: these will not be auto-cleaned. Document in tasks.
- Recursive directory walk cost: bounded by the number of daily files × agents. With 5 agents × 30 days × 3 categories ≈ 450 files, this is negligible.

## Migration Plan

1. Deploy `hook-processor.mjs` changes first — new debug/error logs go to daily files under `dataDir/logs/`.
2. Deploy `LogRetentionService` in orchestrator — starts cleaning old files on next collector restart.
3. Old single-file logs in `HOOKS_DIR` can be manually removed or left to accumulate (they stop growing after step 1).
4. No config migration needed — all new config fields have defaults.
