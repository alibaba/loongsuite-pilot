## ADDED Requirements

### Requirement: Periodic version checking
The system SHALL periodically poll a remote manifest URL to detect new versions.

#### Scenario: New version detected
- **GIVEN** the Updater is running with a configured manifest URL
- **WHEN** the remote manifest contains a version or git_commit different from the local VERSION file
- **THEN** the Updater initiates download and deployment of the new version

#### Scenario: Already up to date
- **GIVEN** the local version and git_commit match the remote manifest
- **WHEN** the Updater performs a check
- **THEN** no download is initiated and a debug log is emitted

#### Scenario: Manifest unreachable
- **GIVEN** the manifest URL returns a non-200 status or times out
- **WHEN** the Updater performs a check
- **THEN** a warning is logged and the Collector continues running unaffected

#### Scenario: Default check interval
- **GIVEN** no `checkIntervalMs` is configured in config file or environment
- **WHEN** the Updater starts
- **THEN** the default polling interval is 1 minute (60,000 ms)

### Requirement: Safe download and deployment
The system SHALL download, verify, and deploy new versions without risking the running Collector's stability.

#### Scenario: Successful deployment
- **WHEN** a new version tarball is downloaded, extracted, and npm install succeeds
- **THEN** the current pointer is atomically updated to the new version directory and the Collector is restarted

#### Scenario: npm install failure aborts deployment
- **WHEN** `npm install --production` fails for the new version
- **THEN** the current pointer is NOT updated, the Collector continues on the old version, and an error is logged

#### Scenario: Missing dist/index.js aborts deployment
- **WHEN** the extracted package does not contain `dist/index.js`
- **THEN** deployment is aborted with an error

#### Scenario: SHA-256 checksum verification
- **GIVEN** the remote manifest includes a `sha256` field
- **WHEN** the tarball is downloaded
- **THEN** the Updater computes SHA-256 of the downloaded file and aborts if it does not match

#### Scenario: SHA-256 absent (backward compat)
- **GIVEN** the remote manifest does not include a `sha256` field
- **WHEN** the tarball is downloaded
- **THEN** checksum verification is skipped with a warning log

### Requirement: Version comparison prevents accidental downgrade
The system SHALL only update to newer versions, not downgrade to older ones.

#### Scenario: Remote version is higher
- **GIVEN** local version is 1.0.1 and remote version is 1.0.2
- **WHEN** the Updater compares versions
- **THEN** needsUpdate returns true

#### Scenario: Remote version is lower
- **GIVEN** local version is 1.0.2 and remote version is 1.0.1
- **WHEN** the Updater compares versions
- **THEN** needsUpdate returns false (no downgrade)

#### Scenario: Same version different commit
- **GIVEN** local version is 1.0.2 with commit abc and remote is 1.0.2 with commit def
- **WHEN** the Updater compares versions
- **THEN** needsUpdate returns true (rebuild of same version)

#### Scenario: No local version (first deployment)
- **GIVEN** no local VERSION file exists
- **WHEN** the Updater compares versions
- **THEN** needsUpdate returns true

### Requirement: Rollback capability
The system SHALL retain the previous version and support instant rollback.

#### Scenario: Pointer swap on rollback
- **GIVEN** current points to v2 and previous points to v1
- **WHEN** `loongsuite-pilot rollback` is executed
- **THEN** current becomes v1, previous becomes v2, and Collector restarts

#### Scenario: No previous version
- **GIVEN** no previous pointer file exists
- **WHEN** `loongsuite-pilot rollback` is executed
- **THEN** the command fails with an error message

#### Scenario: GC preserves current and previous only
- **WHEN** GC runs after a successful deployment
- **THEN** only the current and previous version directories are retained; all others are deleted

### Requirement: Download retry with exponential backoff
The system SHALL retry failed downloads with exponential backoff to avoid hammering the server.

#### Scenario: Consecutive failures increase delay
- **GIVEN** the download has failed N times consecutively
- **WHEN** the next check cycle arrives
- **THEN** the effective interval is min(baseInterval * 2^N, maxBackoff)

#### Scenario: Success resets backoff
- **GIVEN** a download succeeds after previous failures
- **WHEN** the failure counter is evaluated
- **THEN** it resets to 0 and the normal check interval resumes

### Requirement: Dual-process independence
The system SHALL run the Updater and Collector as independent processes.

#### Scenario: Updater restarts only Collector
- **WHEN** a new version is deployed
- **THEN** the Updater calls `loongsuite-pilot restart-collector` which restarts only the Collector, not the Updater itself

#### Scenario: Collector crash does not affect Updater
- **WHEN** the Collector process crashes
- **THEN** the Updater continues running and launchd/systemd restarts the Collector independently

### Requirement: Service management
The system SHALL integrate with OS service managers for persistent background operation.

#### Scenario: macOS launchd
- **WHEN** `loongsuite-pilot start` is executed on macOS
- **THEN** two launchd plists are written and loaded (Collector + Updater), with KeepAlive for crash recovery

#### Scenario: Linux systemd
- **WHEN** `loongsuite-pilot start` is executed on Linux with systemd --user
- **THEN** two systemd user units are written and enabled (Collector + Updater), with Restart=on-failure

#### Scenario: Fallback to nohup
- **WHEN** neither launchd nor systemd is available
- **THEN** the Collector is started via nohup with PID file tracking

### Requirement: Testability via dependency injection
The system SHALL support injecting a custom base directory for all path operations, enabling isolated testing.

#### Scenario: Updater uses custom baseDir
- **GIVEN** an Updater instance is created with `baseDir = /tmp/test-updater`
- **WHEN** it performs any file operation (download, deploy, pointer update, GC)
- **THEN** all paths are derived from the provided baseDir instead of `~/.loongsuite-pilot`

#### Scenario: Default behavior without baseDir
- **GIVEN** an Updater instance is created without a baseDir parameter
- **WHEN** it operates
- **THEN** all paths use the default `~/.loongsuite-pilot` location (backward compatible)

#### Scenario: Pure utility functions are stateless
- **GIVEN** `compareVersions(a, b)` is called
- **WHEN** comparing two version strings
- **THEN** it returns -1, 0, or 1 with no side effects and no dependency on filesystem or network

### Requirement: Reentry protection
The system SHALL prevent concurrent check executions.

#### Scenario: Concurrent check blocked
- **GIVEN** a check is currently in progress
- **WHEN** another check is triggered (by timer or manually)
- **THEN** the second check returns immediately without performing any work

#### Scenario: Flag reset after completion
- **GIVEN** a check (successful or failed) has completed
- **WHEN** the next check cycle triggers
- **THEN** the checking flag is false and the check proceeds normally
