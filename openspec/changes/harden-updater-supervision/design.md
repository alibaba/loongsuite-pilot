## Context

LoongSuite Pilot runs collector and updater as separate background processes. Updater prepares new versions, switches `current` / `previous`, restarts collector, and then reloads updater so future checks use the new code. That means updater can fail in two different places:

```
old updater
  |
  | prepare candidate: download -> verify -> extract -> npm install
  |   failure here must not activate the candidate
  |
  | activate: write current/previous and sync scripts
  |
  | restart collector and updater
  |   failure here means the update may have replaced updater with broken code
```

The MVP focuses on the smallest reliable loop:
- candidate preparation failure never changes the live version;
- recoverable updater failures never make updater silently disappear;
- activated updates rely on the runtime restart path plus asynchronous heartbeat/watchdog observation;
- collector provides a lightweight safety net when external service managers are absent or unreliable.

## Goals / Non-Goals

**Goals:**
- Keep updater alive and observable during recoverable failures.
- Treat `npm install` and other candidate-preparation failures as retryable, non-activating failures.
- Keep `restart-updater` as a simple runtime restart actuator with process-existence verification and nohup fallback.
- Add collector-side updater watchdog for environments where launchd/systemd is missing, unloaded, or ineffective.
- Keep collector watchdog limited to liveness observation and restart orchestration.
- Keep baseline docs synchronized after implementation.

**Non-Goals:**
- Running collector from the new version while updater temporarily runs from `previous`.
- Adding `updater-daemon.js` current-to-previous import fallback in this MVP.
- Adding package artifact preflight to the GitHub/open-source package in this MVP.
- Adding a third always-on supervisor process.
- Moving manifest checks, downloads, version selection, or deployment into collector.
- Changing agent input, normalization, flusher, or `AgentActivityEntry` behavior.

## Decisions

### 1. Keep updater alive for recoverable failures

Recoverable failures inside update checks or deployment preparation SHALL continue with capped backoff. The existing max-consecutive-failure path should become a degraded state, not a silent `stop()` that clears updater's timer.

Fatal startup failures still exit non-zero so launchd/systemd can retry. The distinction is:
- startup cannot initialize -> fail process;
- update attempt failed -> keep process alive, write heartbeat, alarm, and retry later.

### 2. Publish updater heartbeat

Updater writes an atomic heartbeat file under `~/.loongsuite-pilot/logs/updater-runtime.json`. It includes at least `status`, `pid`, `version`, `updatedAt`, `consecutiveFailures`, and `nextCheckAt` when applicable.

This heartbeat is used by:
- updater diagnostics;
- collector-side watchdog.

### 3. Candidate failures never activate a version

`npm install --production --no-optional`, download, checksum, and extraction all happen before `current` changes. If any step fails:
- leave `current` and `previous` unchanged;
- keep current collector/updater running;
- remove or overwrite partial candidate state on retry;
- record a retryable failure and continue capped backoff.

This handles transient registry/network failures without making updater disappear.

### 4. Do not add package artifact preflight in the open-source MVP

The GitHub/open-source package currently does not support auto-update and its packaging step strips `scripts/updater-daemon.js`. This MVP therefore does not add strict runtime artifact preflight checks to the open-source updater path. Candidate staging still ensures download/extract/npm-install failures do not activate a partial version.

### 5. Keep `restart-updater` as a small runtime actuator

`loongsuite-pilot restart-updater` should remain close to its existing responsibility:
- stop updater through the platform service manager where available;
- clean up stale updater process/PID state;
- sync bootstrap scripts;
- start updater through the service manager;
- verify that an updater daemon process actually exists;
- fall back to nohup if the service manager did not produce a process.

For this MVP, `restart-updater` SHALL NOT wait for a target-version heartbeat, manage pending update state, or roll back version pointers. That richer gate belongs in a later change if we decide the extra shell complexity is worth it. Updater liveness after restart is still observable through `updater-runtime.json` and the collector-side watchdog.

### 6. Collector runs a lightweight updater watchdog

When auto-update is enabled, Orchestrator starts `UpdaterWatchdog`. It checks updater PID/process identity and heartbeat freshness. If updater is missing or stale, it records an alarm and invokes the existing CLI recovery path with rate limiting.

The watchdog must not fetch manifests, download packages, compare versions, write pointers directly, or deploy updates.

### 7. Reuse runtime CLI as recovery actuator

Collector should call CLI commands rather than duplicate service-manager/nohup logic. On Unix, `scripts/loongsuite-pilot.sh` remains responsible for restart verification, process cleanup, and fallback startup. On Windows, the watchdog may invoke the existing PowerShell CLI, but PowerShell `restart-updater` verification enhancement is deferred for this MVP.

## Risks / Trade-offs

- A broken activated updater is not synchronously rolled back by `restart-updater` in this MVP -> mitigated by process verification, heartbeat visibility, watchdog restart, and alarms.
- Persistent npm incompatibility can keep updater degraded for a long time -> mitigated by capped retry and alarms, with no pointer activation.
- Watchdog false positives after sleep/wake or slow startup -> mitigate with startup/wake grace periods and restart rate limiting.
- Collector now supervises updater liveness -> keep the boundary narrow and document it in `docs/modules/core.md`.

## Migration Plan

1. Implement updater heartbeat writer and degraded max-failure behavior.
2. Ensure candidate-preparation failures preserve pointers and keep updater alive.
3. Keep package artifact preflight out of the GitHub/open-source MVP because the open-source package strips updater runtime scripts.
4. Keep Unix `restart-updater` bounded to restart/process verification plus nohup fallback; defer PowerShell restart enhancement.
5. Add `UpdaterWatchdog` and wire it into Orchestrator only when auto-update is enabled.
6. Add unit tests for npm failure retry, degraded state, heartbeat, and watchdog rate limiting.
7. Run typecheck and targeted updater/core/runtime tests where local dependencies permit.
8. Update baseline documentation where present.

Rollback of this code change is normal code rollback. At runtime, disabling auto-update disables collector-side updater supervision.

## Open Questions

- Should the watchdog stale threshold and restart rate limit be fixed constants for MVP or config fields?
- Should `loongsuite-pilot status` display heartbeat freshness later as a diagnostic enhancement?
