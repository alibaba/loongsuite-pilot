# Tasks: Enhance Alarm & Status Reporting

## Task 1: Extend AlarmLevel and AlarmType

**File**: `src/metrics/alarm-manager.ts`

- Add `'1'` to `AlarmLevel` type union
- Add `'USER_ID_FORMAT_ALARM'` to `AlarmType` type union

**Verification**: TypeScript compiles without error.

---

## Task 2: Add user_id to AlarmManager

**Files**:
- `src/metrics/alarm-manager.ts`
- `src/core/orchestrator.ts`

Steps:
1. Extend `AlarmManagerOptions` (or the constructor parameter) to accept `userId: string`
2. Store `userId` as instance property
3. Add `user_id` field to `AlarmEntry` interface
4. In `serialize()`, include `user_id: this.userId` in each serialized entry
5. In Orchestrator, pass `userId: this.config.userId` when constructing AlarmManager

**Verification**: Unit test `alarm-manager.test.ts` updated to verify `user_id` in serialized output.

---

## Task 3: Add user_id to L2 metrics

**File**: `src/metrics/metrics-collector.ts`

Steps:
1. Add `user_id: string` field to `InputMetrics`, `FlusherMetrics`, and `AlarmMetrics` interfaces
2. In `collectL2Inputs()`, `collectL2Flushers()`, `collectL2Alarms()`, populate `user_id: this.userId`

**Verification**: Unit test `metrics-collector.test.ts` or `metrics-writer.test.ts` updated to verify `user_id` in L2 outputs.

---

## Task 4: Add user_id to UpdaterMetrics

**Files**:
- `src/updater/updater-metrics.ts`
- `src/updater/index.ts`

Steps:
1. Extend `UpdaterMetricsOptions` to include `userId: string`
2. Store `userId` as instance property
3. Add `user_id` field to `UpdaterEvent` interface
4. In `writeEvent()` and `writeAlarm()`, include `user_id: this.userId` in produced records
5. In `src/updater/index.ts` `main()`, resolve userId from config file:
   ```
   const userId = process.env.LOONGSUITE_PILOT_USER_ID
     ?? file?.userId ?? file?.['user.id'] ?? os.hostname();
   ```
6. Pass `userId` to `new UpdaterMetrics({ ..., userId })`

**Verification**: Unit test `updater-metrics.test.ts` updated to verify `user_id` in events and alarms.

---

## Task 5: Add userId format check (USER_ID_FORMAT_ALARM)

**Files**:
- `src/metrics/metrics-writer.ts`
- `src/updater/updater-metrics.ts`

Steps:
1. In `MetricsWriter`, add `private checkUserId(): void` method:
   - Get userId from collector
   - If matches `/^\{.*\}$/`, call `alarmManager.record('USER_ID_FORMAT_ALARM', '1', message)`
2. Call `checkUserId()` in `writeL1()` after `checkThresholds()`
3. In `MetricsCollector`, expose a `getUserId(): string` method (or make userId accessible)
4. In `UpdaterMetrics`, add userId format check in `flush()`:
   - Use a `userIdAlarmEmitted: boolean` flag to emit only once per process lifetime
   - If userId matches pattern and not yet emitted, call `writeAlarm(...)` with level `'1'`

**Verification**: Unit tests for both MetricsWriter and UpdaterMetrics verify alarm is emitted when userId has braces format.

---

## Task 6: Add privacy_settings to L1 status

**Files**:
- `src/metrics/metrics-collector.ts`
- `src/metrics/metrics-writer.ts`
- `src/core/orchestrator.ts`

Steps:
1. Extend `MetricsWriterOptions` to include `agentsConfig?: AgentsConfig`
2. Forward `agentsConfig` to `MetricsCollector` constructor (extend `MetricsCollectorOptions`)
3. Add `privacy_settings: string` field to `L1Metrics` interface
4. In `collectL1()`, build the privacy settings object from `agentsConfig`:
   ```ts
   const privacySettings: Record<string, { captureMessageContent: boolean }> = {};
   for (const [agentType, config] of Object.entries(this.agentsConfig ?? {})) {
     privacySettings[agentType] = { captureMessageContent: config.captureMessageContent };
   }
   ```
   Set `privacy_settings: JSON.stringify(privacySettings)`
5. In Orchestrator, pass `agentsConfig: this.config.agents` to MetricsWriter

**Verification**: Unit test verifies `privacy_settings` field is present and correctly serialized in L1 output.

---

## Task 7: Update existing unit tests

**Files**:
- `tests/unit/metrics/alarm-manager.test.ts`
- `tests/unit/metrics/metrics-writer.test.ts`
- `tests/unit/metrics/metrics-collector.test.ts` (if exists)
- `tests/unit/updater/updater-metrics.test.ts`

Steps:
1. Update AlarmManager test fixtures to include `userId` in constructor
2. Assert `user_id` field in serialized alarm entries
3. Update MetricsWriter tests to pass `agentsConfig` and verify `privacy_settings` in L1
4. Update MetricsWriter tests to verify `USER_ID_FORMAT_ALARM` trigger
5. Update UpdaterMetrics tests to pass `userId` and verify it in events/alarms
6. Ensure all existing tests still pass with the new required parameters

**Verification**: `npm test` passes with no failures.

---

## Task 8: Verify implementation conforms to baseline constraints

- AlarmManager changes do not affect the main data pipeline (InputManager → MultiFlusher)
- Monitor module remains optional — new fields are passive additions
- No new external dependencies introduced
- `flattenToStrings` handles all new fields correctly (all are strings)
- Updater process remains independent — no cross-process coupling beyond shared config file read

**Verification**: Run `npm run build && npm test` to confirm type safety and test coverage.
