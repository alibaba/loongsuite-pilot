## 1. Config & Types

- [x] 1.1 Add `LogRetentionConfig` interface to `src/types/index.ts` with fields: `enabled`, `intervalMs`, `hookHistoryDays`, `hookErrorDays`, `hookDebugDays`, `outputDays`, `slsFailedDays`.
- [x] 1.2 Add `retention: LogRetentionConfig` to `AnalyticsConfig` in `src/types/index.ts`.
- [x] 1.3 Add `retention?` section to `ConfigFile` interface in `src/core/config-loader.ts`.
- [x] 1.4 Implement `buildRetentionConfig()` in `src/core/config-loader.ts` with three-layer priority: env vars > config file > defaults. Support `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` as unified override and `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` / `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` for enable/interval control.
- [x] 1.5 Wire `buildRetentionConfig()` into `loadConfig()` return value.

## 2. LogRetentionService

- [x] 2.1 Create `src/core/log-retention-service.ts` with a `LogRetentionService` class. Constructor takes `dataDir: string` and `config: LogRetentionConfig`.
- [x] 2.2 Implement `start()`: schedule first cleanup after 30-second delay, then `setInterval` at `config.intervalMs`. Implement `stop()`: clear timers.
- [x] 2.3 Implement `runCleanup()`: recursively walk `dataDir/logs/`, classify each subdirectory by category (`history` → hookHistoryDays, `errors` → hookErrorDays, `debug` → hookDebugDays, `output` → outputDays, `sls-failed-logs` → slsFailedDays), extract date from filenames matching `*-YYYY-MM-DD.{jsonl,log}`, delete files older than the category cutoff. Always skip today's date. Log summary (files deleted, errors).
- [x] 2.4 Ensure all errors in `runCleanup()` are caught and logged at warn level — never throw.

## 3. Orchestrator Integration

- [x] 3.1 Import and instantiate `LogRetentionService` in `src/core/orchestrator.ts`. Store as private field.
- [x] 3.2 Call `logRetentionService.start()` in `Orchestrator.start()` after `agentDiscoveryService.start()`.
- [x] 3.3 Call `logRetentionService.stop()` in `Orchestrator.stop()` before stopping other subsystems.

## 4. hook-processor.mjs Log Migration

- [x] 4.1 In `assets/hooks/hook-processor.mjs`, change `logDebug()` to write daily files at `{LOONGSUITE_PILOT_LOGS_BASE_DIR}/{agentId}/debug/{agentId}-debug-YYYY-MM-DD.log` instead of `{HOOKS_DIR}/{agentId}_hook.log`. Create the directory if needed.
- [x] 4.2 In `assets/hooks/hook-processor.mjs`, change the `main().catch()` error handler to write daily files at `{LOONGSUITE_PILOT_LOGS_BASE_DIR}/{agentId}/errors/{agentId}-error-YYYY-MM-DD.log` instead of `{HOOKS_DIR}/hook_processor_error.log`. Requires passing `agentId` to the error handler scope.
- [x] 4.3 Remove the old `getLogFile()` function and `_logFile` variable that pointed to HOOKS_DIR.

## 5. Tests

- [x] 5.1 Add unit tests for `LogRetentionService.runCleanup()`: create a temp directory with dated files across categories, run cleanup, verify correct files are deleted and today's files survive.
- [x] 5.2 Add unit tests for date extraction: filenames matching the pattern, filenames that don't match (should be skipped), edge cases (malformed dates, no extension).
- [x] 5.3 Add unit tests for `buildRetentionConfig()`: verify env var override, config file values, defaults, and unified `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` override.
- [x] 5.4 Add a test verifying that unrecognized subdirectories under `logs/` are not touched by cleanup.
- [x] 5.5 Add a test verifying that cleanup errors on individual files do not abort the full scan.
