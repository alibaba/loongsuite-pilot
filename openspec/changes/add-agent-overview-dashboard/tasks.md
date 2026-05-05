## 1. Runtime Summary Model

- [x] 1.1 Define agent grouping metadata for Cursor, Qoder, Qoder CLI, Qoder Work, Claude Code, Codex, and their internal collection methods.
- [x] 1.2 Define summary response types for service health, agent cards, reporting health, activity timeline, and diagnostic details.
- [x] 1.3 Define status rules for running, collecting, idle, stale, unavailable, warning, and error states.
- [x] 1.4 Define user-facing collection type labels such as hook events, session logs, and token usage.
- [x] 1.5 Define attribution rules for Qoder-family data: `qoder-sqlite` belongs to Qoder, `qoder-work-hook` belongs to Qoder Work, and `qoder-cli-*` records are split by variant hints or shown as combined Qoder / Qoder CLI when ambiguous.

## 2. Low-Overhead Aggregation

- [x] 2.1 Implement a read-only runtime summary aggregator over `~/.loongsuite-pilot` files.
- [x] 2.2 Implement PID/process health detection without blocking dashboard requests for long-running commands.
- [x] 2.3 Implement service-log tail parsing for startup, agent lifecycle, dispatch, warning, and error events.
- [x] 2.4 Implement current-day JSONL output aggregation by top-level agent and event type, including Qoder / Qoder CLI variant parsing from output attributes.
- [x] 2.5 Implement SLS failed-log aggregation for persisted upload failures.
- [x] 2.6 Add cache TTL and file metadata checks so repeated dashboard refreshes do not fully rescan unchanged files.
- [x] 2.7 Enforce bounded timeline and bounded file-read limits.

## 3. Local API

- [x] 3.1 Add a `/api/overview` endpoint returning the complete cached dashboard summary.
- [x] 3.2 Add a `/api/overview/agents/:agentId` or equivalent details endpoint for method-level diagnostics.
- [x] 3.3 Keep existing process-monitor endpoints working if sharing the same lightweight server.
- [x] 3.4 Ensure API responses do not include raw prompt, assistant output, tool payload, or transcript contents.
- [x] 3.5 Return explicit "best available" reporting wording when exact remote upload success metrics are unavailable.

## 4. Dashboard UI

- [x] 4.1 Build an overview page section for service running state, version, reporting channels, total events today, failures, and last activity.
- [x] 4.2 Build top-level agent cards for Cursor, Qoder, Qoder CLI, Qoder Work, Claude Code, and Codex.
- [x] 4.3 Build a reporting health section for local backup, SLS enabled state, and persisted upload failures.
- [x] 4.4 Build a recent activity timeline using user-facing event messages.
- [x] 4.5 Add an advanced/details view that can show internal method names without putting them in the main overview.
- [x] 4.6 Keep the initial UI dependency-free or otherwise justify any added dependency.

## 5. Validation and Performance

- [x] 5.1 Add unit tests for mapping internal input IDs and Qoder-family record variants to top-level agents, including `qoder-sqlite` -> Qoder and ambiguous `qoder-cli-*` -> combined Qoder / Qoder CLI.
- [x] 5.2 Add unit tests for service-log parsing using representative real log lines.
- [x] 5.3 Add unit tests for JSONL output aggregation and failed-upload aggregation.
- [x] 5.4 Add tests that verify sensitive message fields are not returned by overview APIs.
- [x] 5.5 Add a performance test or benchmark fixture with large service logs and JSONL files to verify bounded refresh cost.
- [x] 5.6 Manually validate the dashboard against the current `~/.loongsuite-pilot` runtime directory.

## 6. Documentation and Operations

- [x] 6.1 Document how to start the dashboard locally.
- [x] 6.2 Document the meaning of collecting, idle, stale, unavailable, warning, and error states.
- [x] 6.3 Document current reporting limitations, especially that MVP does not claim exact SLS success counts.
- [x] 6.4 Document follow-up work for first-class durable upload success metrics.

## 7. Process Metrics Retention and Charts

- [x] 7.1 Rotate process metrics into hourly CSV files instead of one growing daily file.
- [x] 7.2 Add periodic cleanup for process metrics files older than the configured retention window.
- [x] 7.3 Serve only a recent process metrics window from `/api/metrics` while preserving CSV columns.
- [x] 7.4 Add process metrics status metadata for active window, row count, and source files.
- [x] 7.5 Add Y-axis labels, current values, and peak values to resource charts.
- [x] 7.6 Add tests for hourly file selection and recent-window filtering.

## 8. Dashboard UX Clarifications

- [x] 8.1 Remove the Advanced Details panel from the main dashboard.
- [x] 8.2 Remove collapsed Diagnostics sections from top-level agent cards.
- [x] 8.3 Show user-facing agent states as Active, No recent activity, and Not detected.
- [x] 8.4 Avoid showing collector startup timestamps as Last activity for agents with no event evidence.
- [x] 8.5 Add process chart hover tooltips with nearest sample time and values.
- [x] 8.6 Explain Network Connections labels for INET, EST, and LISTEN.
- [x] 8.7 Hide process metrics sample/file counts from the main page.
- [x] 8.8 Show the dashboard auto-refresh interval next to the latest refresh time.
- [x] 8.9 Set dashboard browser refresh interval to 15 seconds.
- [x] 8.10 Document that overview aggregation is request-driven and does not poll files after the page is closed.
- [x] 8.11 Label Qoder Work token metrics as "Not supported yet".

## 9. Optional Monitor Lifecycle

- [x] 9.1 Keep `loongsuite-pilot start` scoped to the core collector and avoid auto-starting monitor.
- [x] 9.2 Treat the process sampler and dashboard server as one optional `monitor` feature.
- [x] 9.3 Add `loongsuite-pilot monitor-start` to start both sampler and dashboard and print the dashboard URL.
- [x] 9.4 Add `loongsuite-pilot monitor-stop` to stop both sampler and dashboard without stopping core collection/reporting.
- [x] 9.5 Ensure `loongsuite-pilot stop` stops optional monitor processes if they are running.
- [x] 9.6 Restart monitor after auto-update only when monitor was already running.
- [x] 9.7 Keep monitor stopped after auto-update when the user had not started monitor.
