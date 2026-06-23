## Context

This change builds on `add-degraded-startup-alarm` which already established the pattern of reading local state files in `MetricsCollector` and raising alarms via `MetricsWriter.checkStartupMode()`. We extend this pattern with three new alarms and six new L1 fields.

The collector already has access to `dataDir` (passed through to `MetricsCollector`). All new checks read files under `dataDir` and require no additional constructor parameters except `canaryPolicy` which comes from config.

Key file paths (all relative to `dataDir`):
- `loongsuite-pilot-updater.pid` — updater PID file
- `current` — version pointer (text file containing directory name)
- `versions/` — installed version directories
- `previous` — rollback version pointer
- `node-bin` — pinned Node.js binary path

## Goals / Non-Goals

**Goals:**

- Detect updater liveness failure with grace period and consecutive-failure gating.
- Detect broken version pointer and invalid node-bin on every L1 cycle.
- Expose 6 infrastructure health fields in L1 metrics for dashboard visibility.
- Include new fields in community heartbeat (`SELECTED_FIELDS`).

**Non-Goals:**

- Disk usage measurement (too costly for a 10-min sync cycle).
- Fixing the detected issues (auto-repair) — this is monitoring only.
- Updater-side changes.
- Shell script changes.

## Decisions

### Decision 1: All infrastructure checks live in MetricsCollector

New method: `collectInfraHealth(): InfraHealthSnapshot`. Called by `MetricsWriter.writeL1()` alongside `collectL1()`. The snapshot contains all 6 boolean/string fields plus a `updaterConsecutiveFailures` counter for alarm gating.

Rationale: keeps `MetricsCollector` as the single data-gathering point, `MetricsWriter` as the alarm-decision-maker. Same separation as existing CPU/MEM thresholds and init_type alarm.

### Decision 2: Updater liveness — grace period + consecutive failures

```
                    L1 cycle 1   L1 cycle 2   L1 cycle 3   L1 cycle 4   ...
                    (t=0)        (t=10m)      (t=20m)      (t=30m)
grace period?       yes          yes          no           no
updater alive?      -            -            no           no
consecutive fails   0            0            1            2 → ALARM!
```

- `l1CycleCount` tracks how many L1 cycles have occurred (incremented in `collectInfraHealth()`).
- First 2 cycles are grace period (`l1CycleCount <= 2`) — skip updater check entirely.
- After grace period: if updater PID is dead, increment `updaterConsecutiveFailures`. If alive, reset to 0.
- Alarm fires when `updaterConsecutiveFailures >= 2`.

This means the earliest alarm is at the 4th L1 cycle (t=30min), which gives the updater plenty of time to start.

### Decision 3: Version pointer and node-bin — immediate alarm, no consecutive gating

These represent "guaranteed failure on next restart" — no reason to wait for consecutive failures. If the file points to a non-existent target, alarm immediately on each L1 cycle.

### Decision 4: New fields are added to L1Metrics interface

```typescript
export interface L1Metrics {
  // ... existing fields ...
  init_type: string;
  rollback_available: string;    // "true" | "false"
  canary_policy: string;         // "auto" | "latest" | "off" | ""
  version_count: string;         // "2"
  updater_pid_alive: string;     // "true" | "false"
  node_bin_valid: string;        // "true" | "false"
  current_version_valid: string; // "true" | "false"
  __time__: number;
}
```

### Decision 5: MetricsCollector needs canaryPolicy from config

`canaryPolicy` is a config value, not a file. We pass it as a new constructor option: `canaryPolicy?: string`. The orchestrator already passes `userId` and `version`; adding one more field is trivial.

Data flow:
```
Orchestrator
  └─ config.canaryPolicy
       └─→ MetricsWriterOptions.canaryPolicy
             └─→ MetricsCollector opts.canaryPolicy
                   └─→ L1Metrics.canary_policy
```

### Decision 6: Alarm recording in MetricsWriter

New method `checkInfraHealth(health: InfraHealthSnapshot): void` in MetricsWriter, called after `checkStartupMode()`:

```
writeL1()
  ├── collector.collectL1(snapshot)
  ├── collector.collectInfraHealth()   ← NEW
  ├── checkThresholds(metrics)
  ├── checkStartupMode(metrics)
  ├── checkInfraHealth(health)         ← NEW
  ├── sendStatus(...)
  └── sendRunningStatus(...)
```

The infra health fields are merged into the L1 metrics object before sending.

### Decision 7: SELECTED_FIELDS additions

Add to `src/internal/statistic.ts`:
- `rollback_available`
- `canary_policy`
- `version_count`
- `updater_pid_alive`
- `node_bin_valid`
- `current_version_valid`

## Data Flow

```
~/.loongsuite-pilot/
  ├── loongsuite-pilot-updater.pid  ──→ updater_pid_alive
  ├── current                        ──→ current_version_valid
  ├── previous                       ──→ rollback_available
  ├── versions/                      ──→ version_count
  ├── node-bin                       ──→ node_bin_valid
  └── config.json (canaryPolicy)     ──→ canary_policy

MetricsCollector.collectInfraHealth()
  │
  ▼
InfraHealthSnapshot {
  updaterPidAlive, currentVersionValid, nodeBinValid,
  rollbackAvailable, versionCount, canaryPolicy,
  updaterConsecutiveFailures
}
  │
  ├──→ Merged into L1 metrics → JSONL + SLS + heartbeat
  │
  ▼
MetricsWriter.checkInfraHealth()
  ├── updaterConsecutiveFailures >= 2
  │     → UPDATER_NOT_RUNNING_ALARM (level 3)
  ├── !currentVersionValid
  │     → BROKEN_VERSION_POINTER_ALARM (level 2)
  └── !nodeBinValid
        → INVALID_NODE_BIN_ALARM (level 2)
```

## Files Changed

| File | Change |
|------|--------|
| `src/metrics/alarm-manager.ts` | Add 3 new alarm types |
| `src/metrics/metrics-collector.ts` | Add `canaryPolicy` to opts, add `collectInfraHealth()` method, extend L1Metrics interface with 6 fields, internal state for `l1CycleCount` and `updaterConsecutiveFailures` |
| `src/metrics/metrics-writer.ts` | Add `canaryPolicy` forwarding, call `collectInfraHealth()` in writeL1, add `checkInfraHealth()` method, merge infra fields into L1 payload |
| `src/core/orchestrator.ts` | Pass `canaryPolicy` to MetricsWriterOptions |
| `src/internal/statistic.ts` | Add 6 fields to SELECTED_FIELDS |
| `tests/unit/metrics/metrics-collector.test.ts` | Tests for collectInfraHealth (all scenarios) |
| `tests/unit/metrics/metrics-writer.test.ts` | Tests for 3 new alarms (grace period, consecutive failures, immediate fire) |
