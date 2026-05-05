## Why

LoongSuite Pilot currently records useful runtime signals in service logs, input state, local JSONL output, and failed-upload files, but users must understand internal input names and file locations to know whether collection and reporting are healthy. Company developers using LoongSuite Pilot need a low-overhead overview that answers whether Pilot is running, which top-level agents are being collected, how much data was handled, and whether recent reporting had problems.

## What Changes

- Add a user-facing runtime overview dashboard organized by top-level agent/tool, such as Cursor, Qoder, Qoder CLI, Qoder Work, Claude Code, and Codex, instead of internal input implementation names.
- Add a lightweight read-only local status API that summarizes service health, agent collection status, report volume, recent activity, and failures from existing runtime files.
- Group internal collection methods under their user-facing agent, while keeping method-level details available only in an advanced/details view.
- Surface high-signal operational events: service start/stop, agent detected/started/stopped, collected event batches, reporting channels enabled, and upload/report failures.
- Enforce a low-performance-overhead design by using bounded file reads, cached summaries, incremental parsing where practical, and no hot-path blocking work in collection or flushing.
- Avoid adding heavy frontend dependencies for the initial version.

## Capabilities

### New Capabilities

- `agent-overview-dashboard`: User-facing dashboard and local status API for LoongSuite Pilot collection and reporting health, grouped by top-level agent with low runtime overhead.

### Modified Capabilities

- None.

## Impact

- Affected code areas:
  - Runtime status/dashboard assets and local server scripts.
  - Read-only aggregation over `~/.loongsuite-pilot/config.json`, `logs/loongsuite-pilot-service.log`, `logs/input-state.json`, `logs/output/*.jsonl`, hook history directories, and `sls-failed-logs/*.jsonl`.
  - Optional future instrumentation around `InputManager` and flushers if first-class durable report metrics are added.
- No breaking changes to existing input collection, hook installation, or flusher behavior.
- No new external service dependency is required for the MVP.
