## 1. Build Toolchain Setup

- [ ] 1.1 Add `esbuild` as a devDependency (`npm install -D esbuild`)
- [ ] 1.2 Create `build.mjs` with esbuild config: `bundle: false`, `format: 'esm'`, `platform: 'node'`, `target: 'es2022'`, `define: { '__INTERNAL_BUILD__': ... }`, parsing `--internal` from argv
- [ ] 1.3 Create `src/internal/build-flags.d.ts` with `declare const __INTERNAL_BUILD__: boolean;`
- [ ] 1.4 Update `package.json` scripts: `"build": "node build.mjs --internal"`, `"build:internal": "node build.mjs --internal"`, `"build:external": "node build.mjs"`, keep `"typecheck": "tsc --noEmit"`
- [ ] 1.5 Add `define: { '__INTERNAL_BUILD__': 'true' }` to `vitest.config.ts` so tests default to internal-build mode
- [ ] 1.6 Verify `npm run build` produces `dist/` with identical file structure to old `tsc` output; verify `node dist/index.js` starts without error
- [ ] 1.7 Verify `npm run build:external` produces `dist/` where `__INTERNAL_BUILD__` is replaced with `false` and dead branches are removed

## 2. Config Loader — Resolution Logic

- [ ] 2.1 Modify `buildSlsConfig()` in `src/core/config-loader.ts`: remove `destinationOverride` read, replace with `__INTERNAL_BUILD__`-guarded branches per design D3
- [ ] 2.2 Guard `buildInternalSlsEndpoint()` import/call with `if (__INTERNAL_BUILD__)` so esbuild eliminates it in external builds
- [ ] 2.3 Add `logger.warn` when `file?.sls?.destinationOverride` is present in config, informing user the field is deprecated and ignored
- [ ] 2.4 Verify external build: `buildSlsConfig` with no user fields returns empty `endpoints` (SLS disabled)
- [ ] 2.5 Verify external build: `buildSlsConfig` with user fields returns `[userEndpoint]` only

## 3. Config Type Cleanup

- [ ] 3.1 Make `destinationOverride` optional in the `ConfigFile` TypeScript interface (if not already) and add `@deprecated` JSDoc tag
- [ ] 3.2 Remove any direct references to `destinationOverride` in type assertions or config validation code outside of config-loader

## 4. Installer Scripts

- [ ] 4.1 Remove `--default-sls-override` case branch, `DEFAULT_SLS_OVERRIDE` variable, validation logic, and standalone warning from `deploy/installer.sh`
- [ ] 4.2 Remove same from `deploy/installer-inner.sh`
- [ ] 4.3 Remove `destinationOverride` from the `write_config` Node.js inline snippet in both installer scripts
- [ ] 4.4 Add error handling: if user passes `--default-sls-override`, print error "this argument is no longer supported" and exit 1

## 5. Packaging Script

- [ ] 5.1 Update `deploy/package.sh`: replace `npx tsc` with `npm run build` (or `node build.mjs --internal`)
- [ ] 5.2 Add `--external` option to `deploy/package.sh` that invokes `npm run build:external` instead
- [ ] 5.3 Verify `bash deploy/package.sh` produces a working `loongsuite-pilot.tar.gz` with esbuild-compiled dist/

## 6. Unit Tests

- [ ] 6.1 Rewrite `tests/unit/core/config-loader.sls-resolution.test.ts`: replace destinationOverride-based cases with `__INTERNAL_BUILD__`-based cases covering all 4 scenarios from spec (internal+no-user, internal+user, external+no-user, external+user)
- [ ] 6.2 Add test case: internal build with legacy `destinationOverride: true` in config still produces dual-write endpoints
- [ ] 6.3 Add test case: dedup when user fields equal internal constants in internal build
- [ ] 6.4 Delete `tests/unit/deploy/installer.default-sls-override.test.ts`
- [ ] 6.5 Update `tests/unit/deploy/installer-sls-config.test.ts`: remove `destinationOverride` assertions, add assertion that `--default-sls-override` is rejected as unknown arg
- [ ] 6.6 Run full test suite and verify all pass: `npm test`

## 7. Documentation

- [ ] 7.1 Update `README.md` lines 156-178: remove `--default-sls-override` examples and the three-mode SLS resolution rule description; replace with new two-mode description (internal build: always dual-write; no `--default-sls-override` flag)
- [ ] 7.2 Update `README.md` config example (lines 376-419): remove any mention of `destinationOverride`
- [ ] 7.3 Add a note in the previous change `openspec/changes/add-sls-dual-write/proposal.md` header indicating it is superseded by `rm-sls-override-config`
- [ ] 7.4 Update `docs/modules/core.md` "SLS 目的地解析" section to reflect new `__INTERNAL_BUILD__`-based resolution

## 8. Verification

- [ ] 8.1 Run `npm run typecheck` — must pass
- [ ] 8.2 Run `npm run build` (internal) — verify `dist/core/config-loader.js` contains `buildInternalSlsEndpoint` calls
- [ ] 8.3 Run `npm run build:external` — verify `dist/core/config-loader.js` does NOT contain `buildInternalSlsEndpoint` or `INTERNAL_SLS_DESTINATION`
- [ ] 8.4 Run `npm test` — all tests pass
- [ ] 8.5 Run `bash deploy/package.sh` — produces valid tar.gz
