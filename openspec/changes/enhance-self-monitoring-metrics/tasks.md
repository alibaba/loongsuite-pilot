## Tasks

### Task 1: Add 3 new alarm types to AlarmType union

**File:** `src/metrics/alarm-manager.ts`

Add `'UPDATER_NOT_RUNNING_ALARM'`, `'BROKEN_VERSION_POINTER_ALARM'`, and `'INVALID_NODE_BIN_ALARM'` to the `AlarmType` union.

**Acceptance:** TypeScript compiles.

---

### Task 2: Extend L1Metrics interface with 6 new fields

**File:** `src/metrics/metrics-collector.ts`

Add to the `L1Metrics` interface (after `init_type`, before `__time__`):
- `rollback_available: string`
- `canary_policy: string`
- `version_count: string`
- `updater_pid_alive: string`
- `node_bin_valid: string`
- `current_version_valid: string`

**Acceptance:** TypeScript compiles.

---

### Task 3: Add `canaryPolicy` to MetricsCollector constructor

**File:** `src/metrics/metrics-collector.ts`

1. Add `canaryPolicy?: string` to the constructor opts type.
2. Store as `private readonly canaryPolicy: string` (default `''`).

**Acceptance:** Constructor accepts the new field.

---

### Task 4: Implement `collectInfraHealth()` in MetricsCollector

**File:** `src/metrics/metrics-collector.ts`

1. Define `InfraHealthSnapshot` interface:
   ```typescript
   export interface InfraHealthSnapshot {
     updaterPidAlive: boolean;
     currentVersionValid: boolean;
     nodeBinValid: boolean;
     rollbackAvailable: boolean;
     versionCount: number;
     canaryPolicy: string;
     updaterConsecutiveFailures: number;
   }
   ```

2. Add instance state:
   - `private l1CycleCount = 0`
   - `private updaterConsecutiveFailures = 0`

3. Implement `collectInfraHealth(): InfraHealthSnapshot`:
   - Increment `l1CycleCount`.
   - **updaterPidAlive**: If `l1CycleCount <= 2` (grace period), return `true` without checking. Otherwise read `path.join(dataDir, 'loongsuite-pilot-updater.pid')`, parse PID, `process.kill(pid, 0)`. If alive, reset `updaterConsecutiveFailures` to 0. If dead, increment.
   - **currentVersionValid**: Read `path.join(dataDir, 'current')`, trim, check `fs.existsSync(path.join(dataDir, 'versions', value))`.
   - **nodeBinValid**: Read `path.join(dataDir, 'node-bin')`, trim, check `fs.accessSync(path, fs.constants.X_OK)`.
   - **rollbackAvailable**: Read `path.join(dataDir, 'previous')`, trim, check `fs.existsSync(path.join(dataDir, 'versions', value))`.
   - **versionCount**: `fs.readdirSync(path.join(dataDir, 'versions'))` (catch → 0).
   - **canaryPolicy**: Return `this.canaryPolicy`.

**Depends on:** Task 2, Task 3.

**Acceptance:** Method returns correct InfraHealthSnapshot for various file states.

---

### Task 5: Merge infra health fields into collectL1 return value

**File:** `src/metrics/metrics-collector.ts`

Modify `collectL1()` to also call `collectInfraHealth()` internally and merge the 6 string fields into the returned `L1Metrics` object:
- `rollback_available: String(health.rollbackAvailable)`
- `canary_policy: health.canaryPolicy`
- `version_count: String(health.versionCount)`
- `updater_pid_alive: String(health.updaterPidAlive)`
- `node_bin_valid: String(health.nodeBinValid)`
- `current_version_valid: String(health.currentVersionValid)`

Also expose the `InfraHealthSnapshot` as a second return value or store it for the writer to retrieve. Simplest: store as `private lastInfraHealth: InfraHealthSnapshot | null` and add a getter `getLastInfraHealth()`.

**Depends on:** Task 4.

**Acceptance:** `collectL1()` output includes all 6 new fields.

---

### Task 6: Forward `canaryPolicy` through MetricsWriter

**File:** `src/metrics/metrics-writer.ts`

1. Add `canaryPolicy?: string` to `MetricsWriterOptions`.
2. Pass `canaryPolicy: opts.canaryPolicy` to MetricsCollector constructor.

**File:** `src/core/orchestrator.ts`

3. In the `new MetricsWriter({...})` call, add `canaryPolicy: this.config.canaryPolicy ?? ''`.

**Depends on:** Task 3.

**Acceptance:** canaryPolicy flows from config to MetricsCollector.

---

### Task 7: Add `checkInfraHealth()` to MetricsWriter

**File:** `src/metrics/metrics-writer.ts`

1. Add `private checkInfraHealth(): void` method.
2. Get `this.collector.getLastInfraHealth()`. If null, return.
3. Check `updaterConsecutiveFailures >= 2` → record `UPDATER_NOT_RUNNING_ALARM` (level `'3'`).
4. Check `!currentVersionValid` → record `BROKEN_VERSION_POINTER_ALARM` (level `'2'`).
5. Check `!nodeBinValid` → record `INVALID_NODE_BIN_ALARM` (level `'2'`).
6. Call `this.checkInfraHealth()` in `writeL1()` after `this.checkStartupMode(metrics)`.

**Depends on:** Task 1, Task 5.

**Acceptance:** Alarms are recorded with correct types and levels.

---

### Task 8: Add new fields to SELECTED_FIELDS

**File:** `src/internal/statistic.ts`

Add to `SELECTED_FIELDS`:
- `'rollback_available'`
- `'canary_policy'`
- `'version_count'`
- `'updater_pid_alive'`
- `'node_bin_valid'`
- `'current_version_valid'`

**Acceptance:** Community heartbeat includes the new fields.

---

### Task 9: Unit tests for collectInfraHealth

**File:** `tests/unit/metrics/metrics-collector.test.ts`

Add describe block for `collectInfraHealth`:
1. Returns `updaterPidAlive: true` during grace period (first 2 calls) even if PID file missing.
2. Returns `updaterPidAlive: false` after grace period when PID file is missing.
3. Returns `updaterPidAlive: true` when PID file contains current process PID (self-test).
4. Increments `updaterConsecutiveFailures` across calls; resets to 0 when alive.
5. Returns `currentVersionValid: true` when `current` → existing directory.
6. Returns `currentVersionValid: false` when `current` → non-existent directory.
7. Returns `nodeBinValid: true` when node-bin points to an executable file.
8. Returns `nodeBinValid: false` when node-bin points to non-existent path.
9. Returns `rollbackAvailable: true/false` based on `previous` file validity.
10. Returns correct `versionCount` from versions directory.

**Depends on:** Task 4.

---

### Task 10: Unit tests for MetricsWriter infra alarms

**File:** `tests/unit/metrics/metrics-writer.test.ts`

Add describe block for infra alarms:
1. `UPDATER_NOT_RUNNING_ALARM` does NOT fire during first 2 L1 cycles (grace period).
2. `UPDATER_NOT_RUNNING_ALARM` does NOT fire on 1st failure after grace (needs 2 consecutive).
3. `UPDATER_NOT_RUNNING_ALARM` fires after 2 consecutive failures post-grace.
4. `BROKEN_VERSION_POINTER_ALARM` fires immediately when current points to missing dir.
5. `BROKEN_VERSION_POINTER_ALARM` does NOT fire when current is valid.
6. `INVALID_NODE_BIN_ALARM` fires when node-bin is invalid.
7. `INVALID_NODE_BIN_ALARM` does NOT fire when node-bin is valid.

**Depends on:** Task 7.
