## Why

The `add-degraded-startup-alarm` change introduced the first "self-monitoring" signal by reporting `init_type`. This revealed a broader gap: the collector has no awareness of its own infrastructure health beyond CPU/memory. Critical preconditions for service continuity — updater liveness, version pointer integrity, node runtime validity — go unmonitored. When these degrade, operators only discover the problem after a restart fails or an update never arrives.

## What Changes

### New Alarms (First Tier)

- **`UPDATER_NOT_RUNNING_ALARM`** (level 3): Fires when the updater PID file is stale (process not alive) for 2 consecutive L1 cycles. Includes a startup grace period (skip first 2 checks) to allow parallel launchd/systemd startup.
- **`BROKEN_VERSION_POINTER_ALARM`** (level 2): Fires when `~/.loongsuite-pilot/current` points to a non-existent `versions/<dir>/` directory. Checked every L1 cycle.
- **`INVALID_NODE_BIN_ALARM`** (level 2): Fires when `~/.loongsuite-pilot/node-bin` points to a non-existent or non-executable file. Checked every L1 cycle.

### New L1 Metrics Fields (Third Tier)

| Field | Source | Value |
|-------|--------|-------|
| `rollback_available` | Read `previous` file + check directory exists | `"true"` / `"false"` |
| `canary_policy` | `config.json` canary.policy | `"auto"` / `"latest"` / `"off"` / `""` |
| `version_count` | Count entries in `versions/` directory | `"2"` |
| `updater_pid_alive` | Read updater PID file + kill -0 | `"true"` / `"false"` |
| `node_bin_valid` | Check node-bin file exists and is executable | `"true"` / `"false"` |
| `current_version_valid` | Check current → versions/<dir> exists | `"true"` / `"false"` |

All new L1 fields also added to `SELECTED_FIELDS` for the community heartbeat.

## Capabilities

### New Capabilities

- `updater-liveness-check`: Read `loongsuite-pilot-updater.pid`, verify PID is alive via `process.kill(pid, 0)`. Track consecutive failures. Fire alarm after 2 consecutive failures. Skip first 2 L1 cycles as grace period.
- `version-pointer-check`: Read `current` file, resolve to `versions/<value>/`, verify directory exists.
- `node-bin-check`: Read `node-bin` file, verify path exists and is executable (`fs.accessSync(path, fs.constants.X_OK)`).
- `infrastructure-l1-fields`: Collect rollback_available, canary_policy, version_count, updater_pid_alive, node_bin_valid, current_version_valid into L1 metrics.

### Modified Capabilities

- `alarm-type-registry`: AlarmType union extended with 3 new types.
- `l1-metrics-collection`: L1Metrics interface extended with 6 new fields.
- `running-status-fields`: SELECTED_FIELDS extended with new field names.

## Scope

- Collector-side only (TypeScript). No shell script changes.
- All checks are synchronous and lightweight (file existence / PID signal).
- No disk usage calculation (deferred — too costly for L1 cycle).
- No changes to L2 metrics or updater-side metrics.
