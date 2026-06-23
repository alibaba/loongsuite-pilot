## Context

The collector process (`src/index.ts` → `Orchestrator.start()`) already reports L1 metrics every 10 minutes via `MetricsWriter` → `MetricsCollector.collectL1()`. These metrics include OS, version, CPU, memory, and dataflow counters. They are flushed both locally (JSONL) and remotely (SLS webtracking via `sendStatus` / `sendRunningStatus`).

The shell script (`scripts/loongsuite-pilot.sh`) writes `~/.loongsuite-pilot/init-type` during `autostart_install()` with one of: `launchd`, `systemd-user`, `systemd-system`, `initd`, `nohup`. The collector never reads this file.

`AlarmManager` accumulates alarm records keyed by type, serialized every 30s, and sent via `sendAlarm`. The alarm list is cleared after each serialization, so alarms must be re-recorded each cycle to persist.

## Goals / Non-Goals

**Goals:**

- Expose `init_type` as a field in L1 metrics so SLS dashboards can show startup mode distribution.
- Fire `DEGRADED_STARTUP_ALARM` (level 2) continuously (every L1 cycle) when the startup mode is degraded (`nohup` or unknown).
- Include `init_type` in the `pilot_running_status` webtracking (community edition heartbeat).

**Non-Goals:**

- Runtime verification of whether the registered service mechanism is still functional.
- Shell script changes (the file is already written correctly).
- Changes to L2 metrics or updater metrics.

## Decisions

### Decision 1: Read init-type once at startup, store as instance field

`MetricsCollector` constructor reads `path.join(dataDir, 'init-type')` synchronously. If the file doesn't exist or is empty, the value defaults to `"unknown"`. This is a static property of the process — it cannot change while the collector is running.

The `dataDir` path is already passed through `MetricsWriterOptions` → `MetricsWriter` constructor. It needs to be forwarded to `MetricsCollector`.

### Decision 2: Add `init_type` to L1Metrics interface

```typescript
export interface L1Metrics {
  // ... existing fields ...
  init_type: string;   // "launchd" | "systemd-user" | "systemd-system" | "initd" | "nohup" | "unknown"
}
```

`collectL1()` populates it from the stored value.

### Decision 3: Alarm in MetricsWriter.writeL1(), not in MetricsCollector

The alarm recording happens in `MetricsWriter.writeL1()` alongside the existing `checkThresholds()` call. This keeps `MetricsCollector` as a pure data collector and `MetricsWriter` as the decision-maker for alarms.

```
writeL1()
  ├── collector.collectL1(snapshot)     → produces metrics including init_type
  ├── checkThresholds(metrics)          → existing CPU/MEM alarm logic
  ├── checkStartupMode(metrics)         → NEW: DEGRADED_STARTUP_ALARM if init_type is degraded
  ├── appendLine(filePath, ...)         → local JSONL
  ├── sendStatus('pilot_status', ...)   → SLS (internal build)
  └── sendRunningStatus(...)            → SLS community heartbeat
```

### Decision 4: Alarm fires every L1 cycle (persistent warning)

Since `AlarmManager.serialize()` clears the alarm map, a one-time record would only produce a single alarm. To keep the alarm visible as long as the degraded condition persists, `checkStartupMode()` is called on every `writeL1()` cycle (every 10 minutes). This matches how `checkThresholds()` already works for CPU/MEM.

### Decision 5: Degraded means `nohup` or `unknown`

The set of degraded values:
- `"nohup"` — explicitly started without a service manager, will not survive reboot.
- `"unknown"` — init-type file missing or empty, likely running in dev mode or installed before init-type tracking was added.

All other values (`launchd`, `systemd-user`, `systemd-system`, `initd`) are considered healthy.

### Decision 6: Include `init_type` in `SELECTED_FIELDS` for running status

In `src/internal/statistic.ts` (community edition) and `statistic.internal.ts` (internal build), add `'init_type'` to `SELECTED_FIELDS` so the 12-hour heartbeat also carries the startup mode.

## Data Flow

```
~/.loongsuite-pilot/init-type
         │ (read once at startup)
         ▼
MetricsCollector.initType = "launchd" | "nohup" | ...
         │
         ▼ (every 10min)
collectL1() → L1Metrics { ..., init_type: "nohup" }
         │
         ├──→ pilot-metrics.jsonl (local)
         ├──→ sendStatus('pilot_status', ...) (SLS)
         ├──→ sendRunningStatus(...) (SLS heartbeat, 12h)
         │
         ▼
MetricsWriter.checkStartupMode()
         │
         ├── init_type ∈ {"nohup", "unknown"}
         │     → alarmManager.record("DEGRADED_STARTUP_ALARM", "2", message)
         │     → alarm flushed via 30s alarm cycle → pilot-alarms.jsonl + SLS
         │
         └── init_type ∈ {"launchd", "systemd-*", "initd"}
               → no alarm
```

## Files Changed

| File | Change |
|------|--------|
| `src/metrics/metrics-collector.ts` | Add `dataDir` to constructor opts, read `init-type` file, add `init_type` to `L1Metrics`, populate in `collectL1()` |
| `src/metrics/metrics-writer.ts` | Forward `dataDir` to `MetricsCollector`, add `checkStartupMode()` method |
| `src/metrics/alarm-manager.ts` | Add `'DEGRADED_STARTUP_ALARM'` to `AlarmType` union |
| `src/internal/statistic.ts` | Add `'init_type'` to `SELECTED_FIELDS` |
| `src/internal/statistic.internal.ts` | Add `'init_type'` to `SELECTED_FIELDS` (if applicable) |
| `tests/unit/metrics/metrics-collector.test.ts` | Test `init_type` field in L1 output for each init-type value |
| `tests/unit/metrics/metrics-writer.test.ts` | Test `DEGRADED_STARTUP_ALARM` fires for nohup/unknown, doesn't fire for launchd/systemd |
