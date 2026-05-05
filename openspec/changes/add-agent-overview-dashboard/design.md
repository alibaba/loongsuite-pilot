## Context

Loongpilot is a local background collector used by company developers. It already records operational signals across several files under `~/.loongsuite-pilot`: service logs, input offsets, hook history, normalized JSONL output, and SLS failed-upload records. These signals are useful but are currently exposed in implementation terms such as `qoder-cli-hook`, `qoder-sqlite`, offsets, row IDs, and JSONL paths.

The dashboard should assume the user does not know Loongpilot internals. The main mental model must be "Loongpilot is collecting Cursor/Qoder/Qoder CLI/Qoder Work/Claude Code/Codex activity and reporting it", not "InputManager dispatched entries from hook-jsonl input X". Implementation details can exist in an advanced diagnostic view.

Performance is a first-order requirement. The dashboard must not slow down collection or reporting, and its own local API must avoid repeated full-history scans.

## Goals / Non-Goals

**Goals:**

- Present health by top-level agent/tool: Cursor, Qoder, Qoder CLI, Qoder Work, Claude Code, Codex, and future agents.
- Show whether Loongpilot is running, whether each agent is detected/collecting, today and recent event counts, last activity time, enabled reporting channels, and failures.
- Provide a recent activity timeline in user-facing language.
- Keep internal collection methods visible only as secondary detail, grouped under their parent agent.
- Use a lightweight local dashboard with no heavy frontend framework requirement for the initial version.
- Bound CPU, memory, and I/O overhead by using cached summaries and small incremental or tail reads.

**Non-Goals:**

- Do not expose full raw transcript contents or private prompt/output bodies in the overview.
- Do not require a remote service to render the dashboard.
- Do not introduce always-on polling in the collection hot path.
- Do not promise exact SLS success counts until the runtime records first-class durable upload metrics.
- Do not replace the existing process-resource monitor; this dashboard can link to or coexist with it.

## Decisions

### Decision 1: Group by user-facing agent, not input ID

The API will map internal inputs to top-level agents:

| Agent | Internal methods |
| --- | --- |
| Cursor | `cursor-hook` |
| Qoder | `qoder-sqlite`, plus Qoder IDE transcript/session-derived events when distinguishable from raw records |
| Qoder CLI | `qoder-cli-hook`, `qoder-cli-session`, CLI-specific transcript events when distinguishable from raw records |
| Qoder Work | `qoder-work-hook` |
| Claude Code | `claude-code-log` |
| Codex | `codex-log` |

The overview returns agent cards with fields such as `status`, `todayEvents`, `lastActivityAt`, `collectionTypes`, `reportingHealth`, and `warnings`. Internal method IDs appear only in `details.methods[]`.

Qoder-family tools require special handling. Qoder Work is a separate product surface and must not be merged into Qoder or Qoder CLI. `qoder-sqlite` represents Qoder token usage and should be attributed to Qoder. `qoder-cli-hook` and `qoder-cli-session` can contain both Qoder and Qoder CLI records; the API should split them by record-level hints when available, such as `agent.type`, `attributes.qoder_variant`, `entrypoint`, `promptId`, `permissionMode`, or `userType`. If a record or batch from those inputs cannot be reliably split, the dashboard should use a combined "Qoder / Qoder CLI" bucket rather than incorrectly assigning it to one product.

Alternative considered: expose one card per input. Rejected because users care which tool is being collected, not which collector implementation produced the event.

### Decision 2: Start with a read-only local API over existing runtime files

The first implementation should add a local read-only API that derives summaries from:

- `config.json` for data directory, user ID, and enabled flusher configuration.
- `logs/loongpilot-service.log` for startup, agent lifecycle, dispatch events, and errors.
- `logs/output/*.jsonl` for normalized local event counts by agent and event type.
- `sls-failed-logs/*.jsonl` for failed upload counts and recent failure details.
- hook history directories for raw input presence and last modified times.
- `loongpilot.pid` and process checks for service running state.

Alternative considered: add runtime metrics directly to `InputManager` and every flusher before building the dashboard. Rejected for MVP because it touches hot-path code and is not necessary for a useful overview. It remains a follow-up for exact upload-success counters.

### Decision 3: Cache summaries and bound all scans

The local API will maintain an in-process cache with a short TTL, such as 5 seconds. Each refresh will:

- Tail the service log rather than read the full file.
- Count today output JSONL files using a bounded read strategy.
- Cache file metadata and only re-scan files whose size or mtime changed.
- Limit timeline events to a fixed count, such as the latest 100.
- Limit JSONL parsing to current-day files by default.

Dashboard refreshes should use the cached summary endpoint, not independently request multiple large files. The browser should refresh every 15 seconds by default. Aggregation is request-driven: if the dashboard page is closed and no API client calls the local server, the overview aggregator does not keep polling files on its own.

Alternative considered: let the frontend fetch and parse JSONL files directly. Rejected because it duplicates work, exposes raw data unnecessarily, and scales poorly as logs grow.

### Decision 4: Treat reporting health as "best available" for MVP

The dashboard can accurately show local dispatch and JSONL backup counts today. It can also show durable SLS failures from `sls-failed-logs`. It should avoid claiming exact SLS success counts unless first-class success metrics are added.

The wording should distinguish:

- "Processed locally" or "Collected" from JSONL/dispatch counts.
- "Local backup normal" from JSONL output.
- "No persisted upload failures detected" from failed-log absence.
- "SLS enabled" from config.

Alternative considered: infer SLS success from dispatch counts minus failed logs. Rejected because queued/retry behavior and debug-only success logs make that potentially misleading.

### Decision 5: User-facing event model

The API should normalize runtime facts into friendly activity items:

- `service.started`: "Loongpilot started"
- `agent.started`: "Started collecting Cursor"
- `agent.stopped`: "Stopped collecting Qoder"
- `collection.batch`: "Cursor collected 11 events"
- `reporting.channel.enabled`: "SLS reporting enabled"
- `reporting.failure`: "Upload failed and was saved locally"
- `collector.error`: "Collection error"

Each event should include timestamp, severity, agent when applicable, summary text, and optional diagnostic metadata.

### Decision 6: Keep process metrics local, recent, and bounded

The process-resource monitor should not keep appending forever to a single daily CSV. It should rotate process metrics by local hour, keep a short configurable retention window on disk, and serve only the recent window needed by the dashboard.

Defaults:

- Dashboard window: last 60 minutes.
- Disk retention: last 6 hours of hourly CSV files.
- Cleanup interval: every 5 minutes.

The dashboard API should filter rows by timestamp server-side and return CSV with the existing columns for backward compatibility. The frontend should render only the recent window and show Y-axis labels plus current and peak values for each chart.

Alternative considered: keep daily CSVs and trim them in place. Rejected because in-place CSV rewriting is more fragile and more expensive than append-only hourly files plus deletion of old files.

Monitor is an optional user-started feature. `loongpilot start` starts only the core collector. `loongpilot monitor-start` starts both the process sampler and local dashboard server, prints the dashboard URL, and `loongpilot monitor-stop` stops both without stopping core collection/reporting.

Auto-update should preserve the user's monitor choice. If monitor is stopped when an update is applied, the updater must not start it. If monitor is already running, the updater should restart it after the collector restarts so the sampler and dashboard use the newly deployed version.

### Decision 7: Use user-facing dashboard language

The primary dashboard should avoid generic diagnostic panels and internal collector details. Agent cards should use the user-facing statuses `Active`, `No recent activity`, and `Not detected`. Collector startup time should not be shown as agent activity unless actual event/output evidence exists for that agent.

Process-resource charts should support hover inspection for the nearest displayed sample, and Network Connections should explain the labels:

- `INET`: all network connections.
- `EST`: established TCP connections.
- `LISTEN`: listening TCP sockets.

## Risks / Trade-offs

- Full JSONL scans can become expensive as logs grow -> Use current-day defaults, file metadata caching, and bounded timeline parsing.
- Users may misread "no failed uploads" as "all uploads succeeded" -> Use explicit wording and add exact success metrics as a follow-up.
- Service log parsing can break if log messages change -> Keep parser tolerant, prefer structured JSON metadata when available, and add tests with real log samples.
- Qoder, Qoder CLI, and Qoder Work can be conflated if only internal input IDs are used -> Classify by user-facing product first, always attribute `qoder-sqlite` to Qoder, split `qoder-cli-*` records by variant hints when available, and fall back to a combined "Qoder / Qoder CLI" bucket when not reliable.
- Reading local logs could reveal sensitive paths in diagnostic details -> Hide raw paths from the main UI and avoid showing prompt/output bodies.
- A separate dashboard process can drift from the collector state -> Check PID/service status and file mtimes on every cached refresh.
- Process metrics files can grow without bounds -> Rotate by hour, delete files older than the retention window, and have the API return only recent rows.

## Migration Plan

1. Add the local summary API and dashboard as an optional command, without changing collector startup behavior.
2. Validate summaries against existing `~/.loongsuite-pilot` runtime data.
3. Add tests for aggregation, log parsing, failure counting, and performance guardrails.
4. Later, decide whether to integrate the dashboard command into the installed `loongpilot` CLI.

Rollback is simple for the MVP: stop the optional dashboard server. Existing collection and reporting remain unchanged.

## Open Questions

- Should the dashboard be opened by `loongpilot dashboard`, `loongpilot status --web`, or a separate script initially?
- What threshold should mark an agent as "stale" when no recent activity exists?
- Should the overview include token usage by default, or only in agent details?
- When exact SLS success metrics are added, should they be persisted in a daily rollup file or emitted as runtime events?
