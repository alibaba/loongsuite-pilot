## ADDED Requirements

### Requirement: Updater publishes runtime liveness
The updater SHALL publish an atomic runtime heartbeat while auto-update is enabled and the updater process is running. The heartbeat MUST include updater PID, package version, status, last update timestamp, and retry/backoff state when applicable.

#### Scenario: Updater starts successfully
- **WHEN** the updater process starts with auto-update enabled
- **THEN** it writes `logs/updater-runtime.json` with status `running`, its PID, version, and a fresh `updatedAt` timestamp

#### Scenario: Updater enters degraded retry
- **WHEN** update attempts repeatedly fail past the max consecutive failure threshold
- **THEN** updater remains alive and heartbeat reports degraded status, consecutive failure count, and next retry time

### Requirement: Recoverable update failures do not silently stop updater
The updater MUST NOT silently stop or exit successfully because of recoverable update check, download, install, or deployment-preparation failures. It SHALL keep retrying with capped backoff and SHALL emit updater failure alarms while degraded.

#### Scenario: Deployment preparation fails repeatedly
- **WHEN** download, checksum, extraction, or npm install fails repeatedly
- **THEN** updater remains alive, records failure state, schedules the next capped-backoff retry, and reports an updater failure alarm

#### Scenario: Fatal startup failure occurs
- **WHEN** updater cannot load required startup configuration or its entry module throws before startup completes
- **THEN** the process exits non-zero so the service manager can attempt restart

### Requirement: Candidate preparation failure does not activate version
The updater SHALL complete candidate preparation before changing `current` or `previous`. Candidate preparation includes download, checksum verification, extraction, and `npm install`.

#### Scenario: npm install fails transiently
- **WHEN** `npm install --production --no-optional` fails or times out while preparing a candidate update
- **THEN** updater preserves the existing `current` and `previous` pointers, does not activate the candidate version, records a retryable failure, and remains alive for a later retry

#### Scenario: Candidate retry starts after partial failure
- **WHEN** a previous candidate preparation attempt left partial candidate files
- **THEN** the next attempt removes or overwrites partial candidate state before preparing the candidate again

### Requirement: Collector supervises updater liveness
The collector SHALL start a lightweight updater watchdog when auto-update is enabled. The watchdog MUST verify updater process identity and heartbeat freshness, apply startup and sleep/wake grace periods before restarting for stale heartbeat, record alarms for unhealthy states, and invoke runtime CLI recovery through a rate-limited path.

#### Scenario: Updater process is missing
- **WHEN** auto-update is enabled and updater PID is absent, stale, or does not match the updater daemon command
- **THEN** collector records a service-not-running alarm and invokes `loongsuite-pilot restart-updater` if restart rate limits allow

#### Scenario: Updater heartbeat is stale
- **WHEN** auto-update is enabled and updater heartbeat is older than the allowed stale threshold after grace periods expire
- **THEN** collector records an updater failure alarm and invokes `loongsuite-pilot restart-updater` if restart rate limits allow

#### Scenario: Collector starts before updater heartbeat is ready
- **WHEN** the collector watchdog starts and updater heartbeat is missing or stale during the startup grace period
- **THEN** it does not invoke `loongsuite-pilot restart-updater` until the startup grace period expires

#### Scenario: Machine resumes from sleep
- **WHEN** the watchdog detects a delayed tick indicating possible sleep/wake and updater process identity is still valid
- **THEN** it enters a wake grace period and does not restart updater for stale heartbeat until the wake grace period expires

#### Scenario: Restart was attempted recently
- **WHEN** watchdog detects an unhealthy updater but the minimum restart interval has not elapsed
- **THEN** it records or aggregates an alarm without invoking another restart command

### Requirement: Collector watchdog does not perform updater business logic
The collector watchdog MUST NOT fetch manifests, download packages, compare versions, write version pointers directly, or deploy updates. It may only observe local updater liveness, emit alarms, and call runtime CLI recovery commands.

#### Scenario: Watchdog checks updater health
- **WHEN** collector watchdog performs a scheduled health check
- **THEN** it only reads local PID/heartbeat state and may execute runtime CLI recovery commands

### Requirement: Auto-update disabled disables updater supervision
When auto-update is disabled by configuration, updater supervision SHALL NOT restart updater or emit missing-updater alarms.

#### Scenario: Auto-update disabled
- **WHEN** `autoUpdate.enabled` resolves to false
- **THEN** collector-side updater watchdog is not started and missing updater process state is ignored

### Requirement: Runtime recovery verifies Unix updater process state
On Unix platforms, the runtime CLI recovery path SHALL verify that an updater daemon process is actually running after restart and SHALL fall back to nohup when the service manager reports success but no updater process is found. Windows PowerShell restart verification is deferred for this MVP.

#### Scenario: Unix service manager restart does not produce updater process
- **WHEN** `restart-updater` starts updater through launchd, systemd, or init.d but no updater daemon process is detected afterward
- **THEN** it starts updater with the existing nohup fallback and writes the updater PID file

#### Scenario: Runtime recovery remains bounded
- **WHEN** `restart-updater` completes its restart attempt
- **THEN** it does not fetch manifests, wait for target-version heartbeat, manage pending update state, or roll back version pointers
