## 1. Internal Destination Module

- [x] 1.1 Add a TypeScript module under `src` for the built-in SLS destination constants and upload mode.
- [x] 1.2 Export the destination shape in a way that `config-loader.ts` can consume without duplicating endpoint, project, or logstore strings.
- [x] 1.3 Keep the module boundary narrow and documented so a later packaging step can target it for obfuscation.

## 2. Runtime Config Resolution

- [x] 2.1 Update `buildSlsConfig()` to use the internal destination for endpoint, project, logstore, mode, and generated `SlsEndpoint` entries.
- [x] 2.2 Stop reading `file.sls.endpoint`, `file.sls.project`, and `file.sls.logstore` from `config.json` for normal SLS destination resolution.
- [x] 2.3 Preserve supported non-destination config controls such as `sls.enabled`, `sls.batchMaxSize`, and `sls.flushIntervalMs`.
- [x] 2.4 Keep `SLS_ENDPOINT`, `SLS_PROJECT`, and `SLS_LOGSTORE` environment overrides active and make their precedence explicit in tests.

## 3. Installer Updates

- [x] 3.1 Update `deploy/installer.sh` so fresh installs do not write default `sls.endpoint`, `sls.project`, or `sls.logstore` values into `config.json`.
- [x] 3.2 Update `deploy/installer-inner.sh` with the same installer config behavior.
- [x] 3.3 Retain installer flags for SLS destination and ensure they only write destination fields when explicitly provided by the operator.
- [x] 3.4 Ensure reinstall behavior preserves existing config files without relying on legacy SLS destination fields.

## 4. Documentation and Examples

- [x] 4.1 Update README installation and configuration examples to stop exposing the internal default SLS destination.
- [x] 4.2 Document that existing `config.json` SLS destination fields may remain on disk but no longer affect the packaged runtime.
- [x] 4.3 Add release-note wording for users who previously customized SLS destination through `config.json`.

## 5. Verification

- [x] 5.1 Update `tests/unit/core/config-loader.test.ts` to assert built-in SLS defaults are used when no destination is present in `config.json`.
- [x] 5.2 Add coverage that legacy `config.json` destination fields are ignored.
- [x] 5.3 Add coverage that `sls.enabled`, `sls.batchMaxSize`, and `sls.flushIntervalMs` still work.
- [x] 5.4 Add or update installer tests or script review checks covering fresh install and reinstall config output.
- [ ] 5.5 Run `npm test` and `npm run typecheck`.

## Deferred: Packaging Obfuscation

Packaging obfuscation is intentionally out of scope for this apply. It will be handled as a separate release hardening change after the config behavior is verified.
