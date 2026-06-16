## Why

The updater is responsible for keeping deployed collectors healthy, but it currently has failure modes where the updater can silently stop, fail to start from a bad `current` pointer, or rely entirely on launchd/systemd recovery. This creates an operational blind spot: collector may continue running while auto-update is dead, leaving the installation unable to receive fixes without manual intervention.

## What Changes

- Add an updater supervision capability that makes updater liveness observable from outside the updater process.
- Harden updater stop/retry semantics so max-failure handling remains recoverable by service managers or by continued long-backoff retry.
- Add collector-side updater watchdog logic that detects missing or stale updater liveness and invokes the existing `loongsuite-pilot restart-updater` recovery path with rate limiting.
- Strengthen `restart-updater` only enough to verify that an updater daemon process actually exists after service-manager restart, then preserve the existing nohup fallback.
- Treat transient `npm install` failures as recoverable deployment failures: do not activate the candidate version and do not let updater silently stop.
- Extend metrics/alarms to report updater supervision failures without introducing a new data collection pipeline.

## Capabilities

### New Capabilities
- `updater-supervision`: Defines updater liveness, restart, and alarm behavior across updater, runtime CLI, and collector-side watchdog responsibilities.

### Modified Capabilities
- None. `openspec/specs/` has no existing baseline capability spec for auto-update or runtime service supervision, so this change introduces a focused capability spec.

## Impact

- Affected code areas:
  - `src/updater/`: updater retry/stop semantics, heartbeat/liveness publication, candidate staging, updater metrics.
  - Runtime CLI: Unix `scripts/loongsuite-pilot.sh` restart verification and PID/process checks; Windows PowerShell restart enhancement is deferred for this MVP.
  - `src/core/`: Orchestrator wiring for collector-side updater watchdog.
  - `src/metrics/`: alarm context and flush behavior for updater supervision alerts.
  - `tests/unit/updater/`, `tests/unit/core/`, and runtime shell tests if available.
- No breaking changes to collector input, normalization, flusher, SLS, JSONL, HTTP, or OTLP trace data contracts.
- No changes to `AgentActivityEntry` schema.

## Affected Baseline Modules

- `docs/modules/updater.md`: updater retry, stop, heartbeat, candidate staging, and max-failure behavior.
- `docs/modules/runtime.md`: CLI/service-manager restart behavior and nohup fallback behavior, with PowerShell restart enhancement deferred.
- `docs/modules/core.md`: Orchestrator ownership of a lightweight updater watchdog as lifecycle supervision, while keeping auto-update business logic in the updater module.
- `docs/constitution.md`: no architecture principle changes expected; the change aligns with graceful lifecycle and restart recovery.

## Baseline Documentation Updates

- Implementation should update available baseline docs after the behavior is finalized.
- No baseline constraint needs to be violated. The only boundary clarification is that collector may supervise updater liveness and trigger restart, but must not perform manifest checks, downloads, deployment, or version selection.
