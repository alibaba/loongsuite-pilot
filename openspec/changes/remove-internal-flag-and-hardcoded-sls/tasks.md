# Tasks: Remove Internal Flag and Hardcoded SLS Destination

## 3.1 Delete Built-in SLS Destination

- [x] T1: Delete `src/internal/sls-destination.ts`
- [x] T2: Remove `INTERNAL_SLS_DESTINATION` / `buildInternalSlsEndpoint` imports and references from `config-loader.ts`
- [x] T3: Simplify `buildSlsConfig()` — remove dual-write logic, config has endpoints → use them, no config → `endpoints = []`

## 3.2 Remove `internal` Flag

- [x] T4: Remove `internal` field from `ConfigFile` interface (`config-loader.ts`)
- [x] T5: Remove `internal` field from `AnalyticsConfig` type (`types/index.ts`)
- [x] T6: Remove `LOONGSUITE_PILOT_INTERNAL` env var reading (`config-loader.ts:157`)
- [x] T7: `serviceNamePrefix` — remove internal ternary, default to `''`
- [x] T8: `buildSlsConfig()` — remove `if (internal)` branches, unify to "has config → enable"
- [x] T9: `buildUserSlsEndpoint()` — remove `args.internal` and fallback to internal endpoint
- [x] T10: `isAgentGatedEnabled()` — remove `if (this.config.internal) return true` line (`orchestrator.ts:649`)
- [x] T11: `buildAutoUpdateConfig()` — remove `internal` parameter, no `packageUrl` → `enabled: false`
- [x] T12: SLS `enabled` — remove `else if (internal)` branch, unify to "has complete endpoint config → enable"

## 3.3 Remove Hardcoded Auto-Update OSS URLs

- [x] T13: Delete `BASE_PACKAGE_URL`, `INTERNAL_RELEASE_PACKAGE_URL`, `INTERNAL_TEST_PACKAGE_URL`, `EXTERNAL_RELEASE_PACKAGE_URL`, `EXTERNAL_TEST_PACKAGE_URL` constants
- [x] T14: Delete `resolveDefaultPackageUrl()` function
- [x] T15: `buildAutoUpdateConfig()` — no `packageUrl` config → `enabled: false`, keep manifestUrl auto-derivation

## 3.4 Update Installer

- [x] T16: `installer-inner.sh` — inject internal SLS endpoint/project/logstore into config.json, remove `internal: true`
- [x] T17: `installer.sh` — remove `internal: false` from config generation

## 3.5 Update Tests

- [x] T18: Update `tests/unit/core/config-loader.sls-resolution.test.ts` — remove internal-related test cases, add config-driven tests
- [x] T19: Update `tests/unit/core/config-loader.test.ts` — remove internal references
- [x] T20: Update `tests/unit/core/orchestrator.test.ts` — remove internal gate test

## 3.6 Update Baseline Docs

- [x] T21: Update `docs/modules/core.md` — rewrite "SLS 目的地解析" section
- [x] T22: Verify implementation conforms to baseline constraints
