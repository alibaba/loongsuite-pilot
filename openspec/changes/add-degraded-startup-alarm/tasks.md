## Tasks

### Task 1: Add `DEGRADED_STARTUP_ALARM` to AlarmType union

**File:** `src/metrics/alarm-manager.ts`

Add `'DEGRADED_STARTUP_ALARM'` to the `AlarmType` union type.

**Acceptance:** TypeScript compiles. The new type is available for `AlarmManager.record()` calls.

---

### Task 2: Add `init_type` to MetricsCollector

**File:** `src/metrics/metrics-collector.ts`

1. Add `dataDir: string` to the constructor options.
2. In the constructor, read `path.join(dataDir, 'init-type')` synchronously via `fs.readFileSync`. If the file doesn't exist or is empty, default to `"unknown"`. Store as `private readonly initType: string`.
3. Add `init_type: string` to the `L1Metrics` interface.
4. In `collectL1()`, include `init_type: this.initType` in the returned object.

**Acceptance:** `collectL1()` returns an object with `init_type` matching the file contents.

---

### Task 3: Forward `dataDir` to MetricsCollector

**File:** `src/metrics/metrics-writer.ts`

In the `MetricsWriter` constructor, pass `dataDir: opts.dataDir` to the `MetricsCollector` constructor (in addition to the existing `version` and `userId`).

**Acceptance:** `MetricsCollector` receives the data directory path.

---

### Task 4: Add `checkStartupMode()` to MetricsWriter

**File:** `src/metrics/metrics-writer.ts`

1. Add a `private checkStartupMode(metrics: L1Metrics): void` method.
2. Check if `metrics.init_type` is `"nohup"` or `"unknown"`.
3. If degraded, call `this.alarmManager.record('DEGRADED_STARTUP_ALARM', '2', 'Service started without autostart registration (init_type=<value>), will not survive reboot')`.
4. Call `this.checkStartupMode(metrics)` in `writeL1()`, after the existing `this.checkThresholds(metrics)` call.

**Depends on:** Task 1, Task 2, Task 3.

**Acceptance:** `DEGRADED_STARTUP_ALARM` is recorded on every L1 cycle when init_type is degraded.

---

### Task 5: Add `init_type` to running status SELECTED_FIELDS

**File:** `src/internal/statistic.ts`

Add `'init_type'` to the `SELECTED_FIELDS` set so the community edition 12-hour heartbeat includes the startup mode.

**Acceptance:** `sendRunningStatus` includes `init_type` in the payload when present in the input data.

---

### Task 6: Unit tests for MetricsCollector init_type

**File:** `tests/unit/metrics/metrics-collector.test.ts`

Add tests:
1. When `init-type` file contains `"launchd"`, `collectL1()` returns `init_type: "launchd"`.
2. When `init-type` file contains `"nohup"`, `collectL1()` returns `init_type: "nohup"`.
3. When `init-type` file does not exist, `collectL1()` returns `init_type: "unknown"`.
4. When `init-type` file is empty, `collectL1()` returns `init_type: "unknown"`.

**Depends on:** Task 2.

---

### Task 7: Unit tests for MetricsWriter DEGRADED_STARTUP_ALARM

**File:** `tests/unit/metrics/metrics-writer.test.ts`

Add tests:
1. When `init_type` is `"nohup"`, `DEGRADED_STARTUP_ALARM` is recorded after `writeL1()`.
2. When `init_type` is `"unknown"`, `DEGRADED_STARTUP_ALARM` is recorded after `writeL1()`.
3. When `init_type` is `"launchd"`, no `DEGRADED_STARTUP_ALARM` is recorded.
4. When `init_type` is `"systemd-user"`, no `DEGRADED_STARTUP_ALARM` is recorded.

**Depends on:** Task 4.
