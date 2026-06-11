## 1. Types & Interfaces

- [x] 1.1 Add `CanaryManifest` interface to `src/types/index.ts` — extends `VersionManifest` with `rollout_percentage: number` and `hotfix_version?: number`
- [x] 1.2 Extend `AutoUpdateConfig` in `src/types/index.ts` with `installId?: string`, `autoCanary?: boolean`, `noCanary?: boolean`, `canaryHotfixVersion?: number`

## 2. Config Loader

- [x] 2.1 Extend `config.json` schema in `src/core/config-loader.ts` to recognize `installId`, `autoCanary`, `noCanary`, and `canary.hotfix_version` fields
- [x] 2.2 Extend `buildAutoUpdateConfig()` to include `installId`, `autoCanary`, `noCanary`, and `canaryHotfixVersion` in the returned config

## 3. Bucketing & Version Utils

- [x] 3.1 Add `deterministicBucket(installId: string): number` to `src/updater/version-utils.ts` — returns `SHA256(installId) % 100`
- [x] 3.2 Add unit tests for `deterministicBucket` — stability, range `[0, 99]`, distribution sanity check

## 4. Updater Core Logic

- [x] 4.1 Add `resolveTargetVersion()` to `src/updater/updater.ts` — parses canary manifest, applies decision priority (noCanary > autoCanary > bucket), returns `{ manifest, channel }`. Wrap in try/catch with stable fallback
- [x] 4.2 Add `installId` auto-generation — on first canary check, if `installId` missing from config, generate UUID v4 and write to `config.json`
- [x] 4.3 Modify `check()` to call `resolveTargetVersion()` when canary field is present in fetched manifest
- [x] 4.4 Modify `needsUpdate()` to accept a `channel` parameter — when channel is `canary` and versions match, compare remote `hotfix_version` vs local `canary.hotfix_version`
- [x] 4.5 After successful canary update, write remote `hotfix_version` (default 0) to `config.json` at `canary.hotfix_version`
- [x] 4.6 Add rollout decision logging — log channel, target version, bucket, and percentage after `resolveTargetVersion()`

## 5. Updater Tests

- [x] 5.1 Test `resolveTargetVersion()` — no canary field, noCanary flag, autoCanary flag, bucket in/out of percentage, percentage=0, malformed canary fallback
- [x] 5.2 Test `needsUpdate()` with canary channel — hotfix_version comparison, same version different hotfix, stable channel ignores hotfix_version
- [x] 5.3 Test installId auto-generation — missing installId is created, existing installId is preserved
- [x] 5.4 Test canary state persistence — hotfix_version written to config after update

## 6. Release Scripts

- [x] 6.1 Add `--canary` and `--hotfix` flags to `deploy/release.sh` — canary mode skips updating stable fields, hotfix mode auto-increments hotfix_version without version bump
- [x] 6.2 Modify `deploy/upload.sh` to support canary mode — update `latest.json` canary field instead of top-level stable fields, set `rollout_percentage=0`
- [x] 6.3 Create `deploy/rollout.sh` — implement `--percentage N` (update rollout_percentage in canary field) and `--promote` (copy canary to top-level, remove canary field)

## 7. Baseline Documentation Update

- [x] 7.1 Update `docs/modules/updater.md` — document resolveTargetVersion(), hotfix_version comparison, installId management, canary fallback behavior
- [x] 7.2 Update `docs/modules/core.md` — document new config.json fields (installId, autoCanary, noCanary, canary.hotfix_version) and buildAutoUpdateConfig() extensions
- [x] 7.3 Update `docs/modules/types.md` — document CanaryManifest interface and AutoUpdateConfig extensions
