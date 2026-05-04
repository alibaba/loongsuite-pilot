## Why

The auto-update subsystem is a critical but undocumented part of the platform. It has been running in production without a formal spec, and code review revealed several bugs ranging from a misconfigured polling interval (60ms instead of 1 hour) to missing safety checks during deployment.

## What Changes

- Document the existing auto-update architecture, requirements, and known issues as a formal OpenSpec capability spec.
- Fix 5 identified bugs in the updater:
  1. **Critical**: `DEFAULT_CHECK_INTERVAL_MS` is 60ms instead of 1 hour.
  2. **High**: `npm install` failure does not abort deployment — new version is activated with missing dependencies.
  3. **Medium**: Version comparison uses string equality — remote version lower than local still triggers "update" (accidental downgrade).
  4. **Medium**: Downloaded tarball has no integrity verification (checksum/signature).
  5. **Low**: No retry with exponential backoff on download failure.
- Refactor for testability:
  - Extract pure functions (`compareVersions`, `computeSha256`) to `src/updater/version-utils.ts`.
  - Add `baseDir` dependency injection to `Updater` constructor for filesystem isolation in tests.
- Add comprehensive test suite (65 test cases):
  - Pure logic tests for version comparison and config loading.
  - Unit tests with full I/O mocking for `Updater` class.
  - Integration tests using real filesystem and tar against a disposable tmpdir.

## Capabilities

### New Capabilities
- `auto-update`: Formal specification of the runtime auto-update subsystem covering version checking, download, deployment, restart, rollback, and service management.

### Modified Capabilities
- None (all changes are within the auto-update subsystem itself).

## Impact

- Fixes a critical polling bug that could cause excessive network traffic and OSS cost.
- Prevents deployment of broken versions when npm install fails.
- Adds semver-aware version comparison to prevent accidental downgrades.
- Adds SHA-256 checksum verification for downloaded packages.
- Adds exponential backoff retry for download failures.
- Establishes 65 test cases covering all update scenarios (previously zero coverage for updater).
- No changes to collector, inputs, flushers, or hook behavior.
