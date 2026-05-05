# LoongSuite Pilot Dashboard

This lightweight local dashboard shows LoongSuite Pilot collection and reporting health.

## Start

```bash
loongsuite-pilot monitor start
```

Open:

```text
http://127.0.0.1:8765/
```

The same server also exposes:

- `GET /api/overview` - cached user-facing collection/reporting summary.
- `GET /api/overview/agents/:agentId` - method-level diagnostics for one agent.
- `GET /api/metrics` - process resource CSV used by the resource charts.
- `GET /api/status` - process resource CSV metadata.

The page refreshes every 15 seconds while it is open.

## Optional Lifecycle

The monitor is optional. It includes both the process sampler and the local dashboard server. `loongsuite-pilot start` starts the core collector only; it does not automatically start monitor.

Use this command when you want the optional UI:

```bash
loongsuite-pilot monitor start
```

Stop it without stopping LoongSuite Pilot collection/reporting:

```bash
loongsuite-pilot monitor stop
```

`loongsuite-pilot stop` stops the optional monitor if it is running. Generated Process Resources CSV files are kept according to the monitor retention policy.

## Status Meanings

- `Active`: LoongSuite Pilot has processed recent events for this agent.
- `No recent activity`: Events exist today, but the latest activity is older than the freshness window.
- `Not detected`: No actual event evidence is available for this agent on this machine.
- `warning`: A non-fatal issue exists, such as persisted upload failures.
- `error`: A collector or reporting error was observed.

## Reporting Notes

The MVP reports local processing and local JSONL backup counts from current-day output files. It also shows persisted SLS upload failures from `sls-failed-logs`.

When SLS is enabled and no failed upload records exist, the dashboard says "no persisted upload failures detected" instead of claiming exact remote upload success. Exact SLS success counts require future first-class durable upload metrics from the flusher path.

## Performance Notes

The dashboard API is read-only and does not run inside the collection hot path. It aggregates files only when API requests arrive, so closing the page stops browser-triggered refresh requests. It uses a short cache TTL, current-day output files, service-log tail reads, metadata caching, bounded JSONL reads, and a fixed-size activity timeline to avoid repeated full-history scans.

Process-resource metrics are kept local and bounded:

- The monitor writes hourly CSV files named `loongsuite-pilot-process-YYYY-MM-DD-HH.csv`.
- The dashboard reads the last 60 minutes by default.
- Old hourly metrics files are deleted after `LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS`, default `6`.
- The chart legend shows both the latest value and peak value in the displayed window.
- Hovering a process-resource chart shows the nearest sample time and values.
- Network chart labels: `INET` is all network connections, `EST` is established TCP connections, and `LISTEN` is listening TCP sockets.

Useful environment variables:

- `LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES`: dashboard metrics window, default `60`.
- `LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS`: on-disk metrics retention, default `6`.
- `LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS`: cleanup interval, default `300`.
