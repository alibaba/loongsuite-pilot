## Why

The loongsuite-pilot service supports multiple startup mechanisms: launchd (macOS), systemd user-level, systemd system-level, init.d, and nohup fallback. The shell script (`loongsuite-pilot.sh`) already records the chosen mechanism in `~/.loongsuite-pilot/init-type`, but the Node.js collector process never reads this file — it has no awareness of how it was started.

This creates a monitoring blind spot: when a user's service falls back to `nohup` mode (or the init-type file is missing), the service will not survive a reboot, but there is no alarm to flag this. Operators only discover the problem after users report that their pilot stopped collecting data post-reboot.

## What Changes

- Read `~/.loongsuite-pilot/init-type` at collector startup and expose the value as `init_type` in L1 Metrics (`pilot_status` topic) and `pilot_running_status`.
- Add a new alarm type `DEGRADED_STARTUP_ALARM` (level 2) that fires on every L1 metrics cycle when `init_type` is `nohup` or missing/empty, indicating the service is not registered for autostart and will not survive a reboot.
- Add `DEGRADED_STARTUP_ALARM` to the `AlarmType` union in `alarm-manager.ts`.

## Capabilities

### New Capabilities

- `init-type-reporting`: Read `~/.loongsuite-pilot/init-type` at startup, add `init_type` field to `L1Metrics` interface and `SELECTED_FIELDS` in `statistic.ts` for running status reporting.
- `degraded-startup-alarm`: Record `DEGRADED_STARTUP_ALARM` (level 2) on every L1 cycle when `init_type` is `"nohup"` or unknown (file missing/empty). Alarm message: `"Service started without autostart registration (init_type=<value>), will not survive reboot"`.

### Modified Capabilities

- `l1-metrics-collection`: `MetricsCollector.collectL1()` includes the new `init_type` field.
- `alarm-type-registry`: `AlarmType` union extended with `DEGRADED_STARTUP_ALARM`.

## Scope

- Collector-side only (TypeScript). No shell script changes.
- No changes to L2 metrics (per-input / per-flusher).
- No runtime verification of whether the registered service mechanism is actually functional (e.g., checking if the plist file still exists). That would be a separate change.
