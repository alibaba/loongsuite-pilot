## Context

The auto-update subsystem enables deployed ai-agent-collector instances to self-update without operator intervention. It consists of:

- A standalone **Updater process** (`src/updater/`) that polls a remote manifest, downloads new versions, and restarts the Collector.
- **Bootstrap scripts** (`scripts/collector-daemon.js`, `scripts/updater-daemon.js`) that resolve the current version via pointer files.
- **CLI integration** (`scripts/aac.sh`) with launchd/systemd service management.
- **Build & deploy tooling** (`deploy/package.sh`, `deploy/upload.sh`) that publishes versioned packages to Alibaba Cloud OSS.

### Architecture: Dual-Process Model

```
launchd / systemd
    │
    ├── com.ai-agent-collector          → aac run          → collector-daemon.js
    │                                                           └── versions/<current>/dist/index.js
    │
    └── com.ai-agent-collector.updater  → aac run-updater  → updater-daemon.js
                                                                └── versions/<current>/dist/updater/index.js
```

The Updater runs independently so it can restart the Collector without terminating itself. Bootstrap scripts are version-agnostic thin loaders that read a `current` pointer file to locate the active version.

### Version Directory Layout

```
~/.ai-agent-collector/
    ├── current          → "<version>_<commit>"   (atomic pointer)
    ├── previous         → "<version>_<commit>"   (rollback pointer)
    ├── versions/
    │   ├── <current>/   → full deployed package
    │   └── <previous>/  → retained for rollback
    ├── bin/             → bootstrap scripts synced from current version
    ├── config.json      → user config, persisted across versions
    └── download-tmp/    → ephemeral download staging
```

### Remote Publish Structure (Alibaba Cloud OSS)

```
<bucket>/<prefix>/
    ├── latest.json          → { version, git_commit, package_url, released_at }
    ├── latest/*.tar.gz
    ├── <version>/*.tar.gz
    └── aac-installer.sh
```

Dual channel: `release` (production) and `test` (pre-release).

## Goals / Non-Goals

**Goals:**
- Document the complete auto-update architecture and requirements.
- Fix all 5 identified bugs (BUG-001 through BUG-005).
- Maintain backward compatibility with existing deployments.

**Non-Goals:**
- Delta/incremental updates (always full tarball).
- Staged rollout / canary release.
- Code signing (beyond checksum verification).
- Changes to collector, inputs, flushers, or hook behavior.

## Decisions

### Fix BUG-001: Default check interval

Change `DEFAULT_CHECK_INTERVAL_MS` from `1 * 60` (60ms) to `60 * 60_000` (1 hour).

Rationale: 1 hour is a safe default for production. Operators can override via config or env var for faster iteration.

### Fix BUG-002: npm install failure should abort deployment

Remove the try/catch that swallows npm install errors. If `npm install --production` fails, the deployment must be aborted — the new version directory is cleaned up, current pointer is not updated, and Collector continues running the old version.

Alternative considered: retry npm install before aborting. Rejected because npm failures are usually deterministic (missing registry, incompatible platform) and retrying would not help.

### Fix BUG-003: Add semver comparison to prevent downgrades

Add a `compareVersions()` helper that performs numeric semver comparison. The updater should only proceed when the remote version is strictly greater than the local version, OR when the versions are equal but the git commit differs (rebuild of same version).

Alternative considered: use a third-party semver library. Rejected to avoid adding a dependency to the updater; simple major.minor.patch splitting is sufficient.

### Fix BUG-004: Add SHA-256 checksum verification

Extend the manifest schema with an optional `sha256` field. When present, the updater computes the SHA-256 hash of the downloaded tarball and compares it to the manifest value. Mismatch aborts the deployment.

When `sha256` is absent from the manifest (backward compat), verification is skipped with a warning.

The upload script is updated to compute and include `sha256` in the manifest.

### Fix BUG-005: Add exponential backoff retry for download failures

Add retry logic to the `check()` method with exponential backoff. On consecutive failures, the next check is delayed by `min(baseInterval * 2^failures, maxBackoff)`. On success, the failure counter resets.

Parameters: base backoff = check interval, max backoff = 6 hours, max consecutive failures before giving up = 10.

## Risks / Trade-offs

- BUG-002 fix makes deployment stricter: if npm install fails on a user's machine, they won't get the update until the issue is resolved. This is intentional — a broken deployment is worse than a delayed update.
- BUG-003 semver comparison assumes standard `major.minor.patch` format. Non-standard version strings fall back to string comparison.
- BUG-004 sha256 is optional in manifest for backward compatibility. Existing manifest files without sha256 will still work but without integrity verification.

## Migration Plan

1. Fix `DEFAULT_CHECK_INTERVAL_MS` in `config-loader.ts`.
2. Make `npm install` failure abort deployment in `updater.ts`.
3. Add `compareVersions()` and integrate into `needsUpdate()`.
4. Add SHA-256 verification to `downloadAndDeploy()`.
5. Add retry backoff logic to `check()`.
6. Update `deploy/upload.sh` to include `sha256` in manifest.
7. Run typecheck and tests.

## Phase 2: Testability Refactoring & Test Suite

### Refactoring: Extract Pure Functions

Extracted `compareVersions()` and `computeSha256()` from `src/updater/updater.ts` into a new module `src/updater/version-utils.ts`.

Rationale: Pure functions with no side effects are trivially testable in isolation — no mocks needed.

### Refactoring: Dependency Injection for `baseDir`

Modified the `Updater` class constructor to accept an optional `baseDir` parameter:
```
new Updater(config: AutoUpdateConfig, baseDir?: string)
```

When `baseDir` is provided, all internal paths (`cacheDir`, `versionsDir`, `current`, `previous`, `bin`) are derived from it. When omitted, the original hardcoded `~/.ai-agent-collector` paths are used (backward compatible).

Rationale: Integration tests can pass a disposable `tmpdir` as `baseDir` and exercise the full download→deploy→pointer-update cycle on a real filesystem without polluting the user's home directory.

### Test Strategy: Three Layers

| Layer | File | Purpose |
|-------|------|---------|
| Pure logic | `tests/unit/updater/compare-versions.test.ts` | 17 cases: semver comparison (major/minor/patch, unequal segments, NaN fallback, edge cases) |
| Pure logic | `tests/unit/updater/config-auto-update.test.ts` | 10 cases: config loading priority (defaults → file → env), channel routing |
| Unit (mock) | `tests/unit/updater/updater.test.ts` | 32 cases: lifecycle, needsUpdate logic, manifest fetching, download/deploy, SHA-256, npm failure, reentry guard, exponential backoff, GC, version resolution |
| Integration (real fs) | `tests/integration/updater-flow.test.ts` | 6 cases: full upgrade cycle, npm failure blocks pointer, SHA-256 mismatch blocks pointer, downgrade prevention, GC keeps current+previous, legacy fallback |

### Key Mocking Strategy

- **Unit tests**: All I/O is mocked (`node:fs/promises`, `node:child_process`, `global.fetch`). `computeSha256` is mocked via `vi.mock` to isolate SHA verification logic from actual file I/O.
- **Integration tests**: Real filesystem in a `tmpdir`. Only `child_process` is partially mocked — `tar` routes to real execution (to create real tarballs), while `npm` and `aac` are mocked to avoid external dependencies. `fetch` is mocked to serve in-memory tarball bytes.

## Open Questions

- Should we add a maximum version age check (refuse to run versions older than N days)?
- Should the updater report update status (success/failure/skipped) to a telemetry endpoint?
