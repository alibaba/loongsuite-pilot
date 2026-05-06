## Why

Hook processors (`cursor-hook-processor.mjs`, `hook-processor.mjs`) write daily-rotated JSONL files and debug/error logs under `~/.loongsuite-pilot/logs/`. The collector inputs (`BaseHookInput` subclasses) only read today's file and never revisit older daily files. There is no mechanism to delete or rotate old files, so they accumulate indefinitely and will eventually consume significant disk space on developer machines.

Additionally, `hook-processor.mjs` writes debug and error logs as single append-only files in `HOOKS_DIR` that grow without bound — a separate but related problem.

The collector output JSONL (`logs/output/*.jsonl`) and SLS failed-upload logs (`sls-failed-logs/*.jsonl`) have the same accumulation issue.

## What Changes

- Add a `LogRetentionService` in the orchestrator that periodically scans log directories under `dataDir/logs/` and deletes files older than a configurable retention period.
- Extend `AnalyticsConfig` and `config-loader` with retention settings (`retention.hookHistoryDays`, `retention.outputDays`, etc.) configurable via config file and environment variables.
- Convert `hook-processor.mjs` debug and error logs from single unbounded files to daily-rotated files under `dataDir/logs/`, so they fall under the same retention policy.
- Protect today's files and files newer than the retention cutoff from deletion.

## Capabilities

### New Capabilities

- `log-retention`: Orchestrator-managed periodic cleanup of dated log files across all `dataDir/logs/` subdirectories, with configurable per-category retention days and environment variable overrides.

### Modified Capabilities

- `hook-processor-logging`: Debug and error logs in `hook-processor.mjs` change from single unbounded files in `HOOKS_DIR` to daily-rotated files under `dataDir/logs/{agent-id}/debug/` and `dataDir/logs/{agent-id}/errors/`.

## Impact

- Affected code areas:
  - `src/core/orchestrator.ts`: Start/stop the retention service.
  - `src/types/index.ts`: Add retention config types.
  - `src/core/config-loader.ts`: Parse retention config from file and env vars.
  - New `src/core/log-retention-service.ts`: The cleanup implementation.
  - `assets/hooks/hook-processor.mjs`: Redirect debug/error logs to daily files under `dataDir/logs/`.
- No breaking changes to existing collection, hook installation, or flusher behavior.
- `BaseHookInput` subclasses are not modified — they already only read today's file.
- Old daily files are deleted, not archived — data that has been consumed by the collector and flushed is no longer needed locally.
