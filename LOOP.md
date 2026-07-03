# Loop Configuration — Minimal Triage

## Active Loops

| Pattern | Cadence | Status | Command |
|---------|---------|--------|---------|
| Daily Triage | 1d | L1 report-only | See README |

## Human Gates

- No auto-fix until L2 checklist complete
- All high-risk paths: human review required

## Safety

- Append each run to `loop-run-log.md`
- Kill switch: `loop-pause-all` — pause schedulers and notify human

## Links

- Pattern: [daily-triage](../../patterns/daily-triage.md)
- Checklist: [loop-design-checklist](../../docs/loop-design-checklist.md)