## Tasks

- [x] Task 1: Fix DEFAULT_CHECK_INTERVAL_MS (BUG-001)
  - File: `src/core/config-loader.ts`
  - Changed `1 * 60` to `60 * 60_000` (1 hour)

- [x] Task 2: Make npm install failure abort deployment (BUG-002)
  - File: `src/updater/updater.ts`
  - Removed try/catch around `npm install --production`; error now propagates to outer catch which cleans up download-tmp and leaves current pointer unchanged

- [x] Task 3: Add semver comparison to prevent downgrades (BUG-003)
  - File: `src/updater/updater.ts`
  - Added `compareVersions(a, b)` helper (split on `.`, compare numerically, fallback to string)
  - Updated `needsUpdate()`: returns true only when remote > local, or same version with different commit

- [x] Task 4: Add SHA-256 checksum verification (BUG-004)
  - File: `src/updater/updater.ts`
  - Added optional `sha256` field to `VersionManifest`
  - After download, computes SHA-256 of tarball and compares to manifest value
  - Aborts if mismatch; skips with warning if `sha256` absent in manifest
  - File: `deploy/upload.sh`
  - Added `shasum -a 256` computation and `sha256` field in generated manifest JSON

- [x] Task 5: Add exponential backoff retry (BUG-005)
  - File: `src/updater/updater.ts`
  - Added `consecutiveFailures` counter and `nextCheckAt` timestamp
  - On failure: increments counter, computes next delay as `min(interval * 2^failures, 6h)`
  - On success: resets counter
  - After 10 consecutive failures: stops updater entirely
  - In `check()`: skips if `Date.now() < nextCheckAt`

- [x] Task 6: Run typecheck and verify
  - `npx tsc --noEmit` passes (only pre-existing sqlite3 type errors remain)

- [x] Task 7: Extract pure functions to `src/updater/version-utils.ts`
  - Moved `compareVersions()` and `computeSha256()` out of `updater.ts`
  - New module exports both functions for isolated testing
  - `updater.ts` imports from `./version-utils.js`

- [x] Task 8: Add `baseDir` parameter to Updater constructor
  - File: `src/updater/updater.ts`
  - Added `UpdaterPaths` interface and `buildPaths(baseDir)` factory
  - Constructor signature: `new Updater(config, baseDir?)`
  - All internal paths (`cacheDir`, `versionsDir`, `currentFile`, `previousFile`, `bootstrapDir`) derived from `baseDir` when provided; defaults to `~/.ai-agent-collector` when omitted

- [x] Task 9: Write pure function tests
  - File: `tests/unit/updater/compare-versions.test.ts` (17 cases)
  - Covers: standard semver (major/minor/patch), unequal segment counts, NaN fallback to string comparison, edge cases (empty string, zero versions, large numbers)

- [x] Task 10: Write config auto-update tests
  - File: `tests/unit/updater/config-auto-update.test.ts` (10 cases)
  - Covers: defaults, file overrides, env overrides, channel routing (test/release), priority (env > file > defaults)

- [x] Task 11: Write Updater class unit tests (mocked I/O)
  - File: `tests/unit/updater/updater.test.ts` (32 cases)
  - Covers: lifecycle (start/stop/disabled), needsUpdate logic (all branches), manifest fetching (error handling), download & deploy (success, npm failure, SHA mismatch, SHA pass, SHA absent, cleanup), reentry protection, exponential backoff (delay calculation, counter reset, max failures stop), GC (preserves current+previous), version resolution (pointer, legacy fallback, null)

- [x] Task 12: Write integration tests (real filesystem)
  - File: `tests/integration/updater-flow.test.ts` (6 cases)
  - Uses real `tmpdir` as `baseDir`, real `tar` for tarball creation/extraction
  - Covers: full upgrade cycle (download→deploy→pointer update), npm failure blocks pointer, SHA-256 mismatch blocks pointer, downgrade prevention, GC removes old versions, legacy package/ fallback

- [x] Task 13: Final validation
  - 65/65 updater tests passing
  - 347/347 total test suite passing (excluding pre-existing sqlite3 native binding issue)
  - TypeScript typecheck clean (no new errors introduced)
