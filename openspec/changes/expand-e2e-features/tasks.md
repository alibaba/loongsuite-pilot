## Implementation Tasks

### 1. ~~Create mock server helper (`scripts/e2e/lib/mock-server.mjs`)~~ ✅

- [x] Implement `createMockServer(handlers, port?)` — generic HTTP server with path→handler map
- [x] Implement `createWebtrackingCollector(port?)` — collects POST body into array, returns `{ received, close }`
- [x] Implement `createManifestServer(port?, { manifest, packagePath })` — serves manifest.json + tar.gz
- [x] Implement `createBrokenPackage(outputPath)` — generates a minimal tar.gz with crashing dist/index.js
- [x] Export all helpers as ESM
- [x] Unit test: `tests/e2e-remote/mock-server.test.mjs` — verify server starts, serves, collects, closes

### 2. ~~Create expand-features script builders (`scripts/e2e/lib/expand-features.mjs`)~~ ✅

- [x] `buildAgentDiscoveryPhaseScript(env)` — shell script for Phase 1 (uninstall/reinstall/wait/assert)
- [x] `buildAutoUpgradePhaseScript(env, mockPort)` — shell for Phase 2 (config inject + wait + assert current)
- [x] `buildAutoRollbackPhaseScript(env, mockPort)` — shell for Phase 3 (installer upgrade broken + assert rollback)
- [x] `buildDualSendPhaseScript(env, portA, portB)` — shell for Phase 4 (config inject + restart + probe + wait)
- [x] `buildMaskingPhaseScript(env)` — shell for Phase 5 (config mask=all + probe with patterns + assert JSONL)
- [x] Each function returns a string (bash script) ready for `runLocalScript()`

### 3. ~~Register `expand-features` scenario in L1 env~~ ✅

- [x] `scripts/e2e/lib/l1-env.mjs`:
  - [x] Add `'expand-features'` to `L1_REQUIRED_BY_SCENARIO` (same required envs as install-smoke)
  - [x] Add to `L1_SCENARIOS` (automatic from key)
  - [x] Add defaults: `E2E_EXPAND_MOCK_PORT_BASE: '19100'`

### 4. ~~Wire scenario in `run-l1.mjs`~~ ✅

- [x] Import expand-features helpers and mock-server helpers
- [x] Add `expandFeaturesScenario(env)` async function:
  - [x] Phase 0: Install pilot (reuse `localBuildInstallScript`)
  - [x] Phase 1-5: For each phase, start mock servers if needed → run shell script → assert → cleanup
- [x] Add to main dispatch: `else if (scenario === 'expand-features') { await expandFeaturesScenario(env); }`
- [x] Support `E2E_EXPAND_SKIP_PHASES` to selectively skip phases
- [x] Each phase prints `[e2e-expand] phase N: <name>` header

### 5. ~~Add unit tests for expand-features scripts~~ ✅

- [x] `tests/e2e-remote/expand-features.test.mjs`:
  - [x] Test each script builder produces valid bash (no syntax errors via `bash -n`)
  - [x] Test mock server integration: start server, verify manifest served, verify POST collected
  - [x] Test broken package generation: tar.gz is valid, contains expected files

### 6. ~~Docker compose env pass-through~~ ✅

- [x] `tests/e2e-docker/docker-compose.l1.yml`:
  - [x] Add `E2E_EXPAND_SKIP_PHASES` and `E2E_EXPAND_MOCK_PORT_BASE` to environment list
  - [x] Ensure `E2E_EXPAND_FAIL_FAST` is passed through

### 7. ~~Integration test: run full expand-features scenario locally~~ ✅

- [x] Verify with `E2E_SCENARIO=expand-features docker compose -f tests/e2e-docker/docker-compose.l1.yml up --build`
- [x] All 5 phases pass
- [x] Clean exit code 0

### 8. ~~Verify implementation conforms to baseline constraints~~ ✅

- [x] Confirm no baseline module behavior is modified
- [x] Confirm E2E code follows existing patterns (script builders, runLocalScript, artifact collection)
- [x] Confirm no new runtime dependencies added to pilot itself
