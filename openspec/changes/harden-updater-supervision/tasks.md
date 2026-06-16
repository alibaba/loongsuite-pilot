## 1. Updater Failure Semantics And Candidate Safety

- [x] 1.1 Add an atomic updater runtime heartbeat writer for `logs/updater-runtime.json` with PID, version, status, timestamp, consecutive failure count, and next retry time.
- [x] 1.2 Replace max-consecutive-failure timer stop behavior with degraded retry state, capped backoff, heartbeat updates, and updater failure alarm/event emission.
- [x] 1.3 Ensure `npm install` failure or timeout preserves existing pointers, leaves the candidate inactive, cleans up or overwrites partial candidate state on retry, and never causes terminal silent updater stop.
- [x] 1.4 Keep package artifact preflight out of the GitHub/open-source MVP because the open-source package strips updater runtime scripts.

## 2. Activation Finalization Safety

- [x] 2.1 Capture pre-update `current` and `previous` pointer values before activation so they can be restored if finalization fails.
- [x] 2.2 Ensure `restart-updater` remains bounded to restart/process verification and does not manage pending update state, wait for target heartbeat, or roll back version pointers.

## 3. Collector-Side Updater Watchdog

- [x] 3.1 Add an `UpdaterWatchdog` module that checks updater PID/process identity and heartbeat freshness on a fixed interval.
- [x] 3.2 Add startup and sleep/wake grace periods before restarting for stale heartbeat.
- [x] 3.3 Add restart rate limiting so unhealthy updater detection cannot trigger continuous restart loops.
- [x] 3.4 Wire the watchdog into `Orchestrator` only when auto-update resolves to enabled.
- [x] 3.5 Record `SERVICE_NOT_RUNNING_ALARM` or `UPDATER_FAILURE_ALARM` through `AlarmManager` for missing, mismatched, stale, or restart-failed updater states.
- [x] 3.6 Ensure watchdog logic only observes local liveness and calls runtime CLI recovery commands; it must not fetch manifests, download packages, compare versions, write pointers directly, or deploy updates.

## 4. Runtime CLI Recovery

- [x] 4.1 Strengthen Unix `loongsuite-pilot restart-updater` process verification so it checks that an updater daemon process actually exists after service-manager restart.
- [x] 4.2 Preserve existing Unix service-manager-first behavior and nohup fallback when launchd/systemd/init.d does not produce a running updater process; defer PowerShell restart enhancement.

## 5. Tests And Validation

- [x] 5.1 Add updater unit tests for heartbeat publication, degraded max-failure retry, `npm install` retry behavior, and candidate cleanup/overwrite.
- [x] 5.2 Validate `restart-updater` shell syntax with `bash -n`; full shell behavior harness is deferred.
- [x] 5.3 Add core watchdog unit tests for healthy updater, missing process, stale heartbeat, startup grace, sleep/wake grace, rate-limited restart, disabled auto-update, and restart command failure.
- [ ] 5.4 Run targeted updater/core/runtime tests and `npm run typecheck` in the GitHub repo after local dependencies are installed.
- [x] 5.5 Verify implementation conforms to baseline constraints.
- [ ] 5.6 Optionally run local E2E tests (user-initiated, see `specs/local-e2e-testing-guide.md`) after implementation.

## 6. Baseline Documentation

- [x] 6.1 Update available OpenSpec docs with heartbeat, degraded retry, candidate safety, and asynchronous watchdog semantics.
- [x] 6.2 Capture Unix runtime restart verification, nohup fallback behavior, and deferred PowerShell enhancement in the change docs.
- [x] 6.3 Capture the collector-side updater watchdog boundary in the change docs.
- [x] 6.4 FINAL: Update baseline docs where present.
