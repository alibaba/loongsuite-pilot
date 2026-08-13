# LoongSuite Pilot Dashboard

The local dashboard starts and stops with the collector. Open:

```text
http://127.0.0.1:8765/
```

The HTTP server exposes only:

- `GET /` - this static page.
- `GET /metrics-summary.json` - the unmodified `logs/metrics-summary.json` file.

The page does not run another aggregation pipeline. Agent cards are created
dynamically from `ranges.today.agentShares`, so newly supported agent types do
not require a dashboard code change.

On the first visit, the page selects Simplified Chinese when the browser's
preferred language starts with `zh`; otherwise it uses English. The language
selector in the header applies immediately to labels, states, errors,
accessibility text, numbers, dates, and times. The choice is saved in
`localStorage` when available; the dashboard continues to work when browser
storage is blocked.

The server binds to `127.0.0.1` on `dashboard.port` (default `8765`) and does not open the system browser.
