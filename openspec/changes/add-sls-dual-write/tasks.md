## 1. Type model and internal destination

- [ ] 1.1 Extend `SlsEndpoint` in `src/types/index.ts` with `endpoint: string`, `mode: SlsMode`, optional `accessKeyId?: string`, optional `accessKeySecret?: string` (preserve existing `name`, `project`, `logstore`, `kind`, `redact`)
- [ ] 1.2 Mark top-level `SlsFlusherConfig.endpoint`, `mode`, `accessKeyId`, `accessKeySecret` as defaulting fields used only by the resolver (or remove if no longer referenced after later tasks)
- [ ] 1.3 Update `INTERNAL_SLS_DESTINATION` in `src/internal/sls-destination.ts`: set `endpointName: 'internal-sls'` and export a helper `buildInternalSlsEndpoint(): SlsEndpoint`
- [ ] 1.4 Define the user endpoint's default `name` as `user-sls` (clear, kebab-case, distinct from `internal-sls` so dual-write produces two clearly-named failed-log files)

## 2. Config resolution (buildSlsConfig)

- [ ] 2.1 In `src/core/config-loader.ts`, refactor `buildSlsConfig` to compute `hasUserDestination` from `(env || file) project && logstore`
- [ ] 2.2 Build the user `SlsEndpoint` from env > config > defaults, with `name: 'agent-activity'`, `mode`, `endpoint`, optional AK fields, `redact: false`
- [ ] 2.3 Read `destinationOverride` with default `true` (when omitted), only meaningful when `hasUserDestination` is true
- [ ] 2.4 Assemble `endpoints[]` per the three-case matrix: `[INTERNAL]`, `[USER]`, or `[USER, INTERNAL]`
- [ ] 2.5 Add a final dedup pass that collapses entries with the same normalized `(endpoint URL, project, logstore)` triple, keeping the first (user-leg wins on collision); URL normalization strips trailing slash, lowercases host, prepends `https://`
- [ ] 2.6 Ensure `enabled` derivation still works: `enabled = endpoints.length > 0 && every endpoint has required fields for its mode`
- [ ] 2.7 Update existing unit tests for `config-loader` to cover the three cases plus the dedup scenarios from `specs/sls-dual-write/spec.md`

## 3. Flusher per-endpoint dispatch

- [ ] 3.1 In `src/flushers/sls-flusher.ts`, replace the constructor's single `ALY` client with a lazy per-endpoint AK client cache keyed by `endpoint.name`
- [ ] 3.2 Change `flushViaAk` to accept the endpoint and use `endpoint.endpoint` + endpoint credentials (resolve client from cache)
- [ ] 3.3 Change `flushViaWebtracking` / `postWebtracking` to derive the URL from `endpoint.endpoint` (drop reliance on `this.config.endpoint`)
- [ ] 3.4 In `flush()`, pick AK vs webtracking from `endpoint.mode` instead of `this.config.mode`
- [ ] 3.5 Update `sendRaw` to honor per-endpoint mode the same way
- [ ] 3.6 Change `persistFailedLogs` to use `<failedLogDir>/<endpoint.name>.jsonl`
- [ ] 3.7 Confirm `Promise.allSettled`-equivalent isolation between endpoints in `flush()` (one endpoint failure must not abort the other)
- [ ] 3.8 Add unit tests covering: webtracking-only single endpoint, AK-only single endpoint, mixed dual-write (AK user + webtracking internal), one-leg failure isolation

## 4. Installer flag wiring

- [ ] 4.1 In `deploy/installer.sh`, add a `DEFAULT_SLS_OVERRIDE_RAW=""` variable and parse `--default-sls-override <val>` and `--default-sls-override=<val>` accepting `true|false`; reject other values
- [ ] 4.2 Mirror the same parsing in `deploy/installer-inner.sh`
- [ ] 4.3 In `write_config` (both scripts), only inject `config.sls.destinationOverride` into the output JSON when the user supplied at least one of `--sls-endpoint`, `--sls-project`, `--sls-logstore`; otherwise emit a warning if `--default-sls-override` was supplied alone
- [ ] 4.4 When `--sls-*` args are supplied and the override flag was not given, default to `destinationOverride: true` (preserves today's behavior)
- [ ] 4.5 Update the help/comment block at the top of both installer scripts to document the new flag and the dual-write use case

## 5. Tests and fixtures

- [ ] 5.1 Add `tests/unit/core/config-loader.sls-resolution.test.ts` exercising the three-case matrix from spec scenarios
- [ ] 5.2 Add `tests/unit/flushers/sls-flusher.dual-write.test.ts` covering per-endpoint mode dispatch, URL derivation, failed-log filename uniqueness
- [ ] 5.3 Add `tests/unit/deploy/installer.default-sls-override.test.ts` (shell-runner test) verifying the resulting `config.json` for each invocation pattern listed in `specs/sls-installer-flags/spec.md`
- [ ] 5.4 Run `npm test` and ensure all suites pass

## 6. Baseline doc updates

- [ ] 6.1 Update `docs/modules/flushers.md` to describe per-endpoint mode and dual-write resolution
- [ ] 6.2 Update `docs/modules/core.md` (config-loader section) with the three-case resolution matrix
- [ ] 6.3 Update `docs/modules/types.md` with the new `SlsEndpoint` shape

## 7. Release notes and verification

- [ ] 7.1 Document the new `--default-sls-override` flag and the dual-write semantics in `README.md` (installer usage section)
- [ ] 7.2 Manual smoke test: install with `--default-sls-override=false` and a test user destination; verify both destinations receive a sample event via the monitor or by inspecting failed-log directory layout when one leg is intentionally misconfigured
- [ ] 7.3 Manual smoke test: install with `--default-sls-override` omitted and a test user destination; verify only the user destination receives events
- [ ] 7.4 Manual smoke test: install with no `--sls-*` args; verify the built-in destination receives events (regression check)
