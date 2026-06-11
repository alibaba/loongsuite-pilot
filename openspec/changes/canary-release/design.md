## Context

LoongSuite Pilot uses a polling-based auto-update system: the updater daemon fetches `latest.json` from OSS every 60s and deploys new versions when available. Today this is all-or-nothing — every client updates simultaneously, giving zero observation window and no blast-radius control.

The full design is documented in `docs/design-canary-release.md`. This artifact captures the key architectural decisions and trade-offs for the implementation.

### Current State
- `latest.json` contains a single version manifest (version, git_commit, package_url, sha256)
- Updater compares remote vs local version, downloads if newer
- No concept of staged rollout or client segmentation
- `config.json` has no installation identity or canary-related fields

### Constraints
- OSS-only infrastructure — no server-side logic, no databases
- Old updaters must continue working unmodified (backward compatibility)
- TypeScript ESM-only codebase, vitest for testing

## Goals / Non-Goals

**Goals:**
- Percentage-based gradual rollout (e.g., 5% → 20% → 50% → 100%)
- Deterministic client bucketing via `installId` (same client always in same bucket)
- Client-side opt-in/opt-out (`autoCanary` / `noCanary` config flags)
- Hotfix iteration on canary without bumping main version (`hotfix_version`)
- Instant stop-the-bleed by setting `rollout_percentage=0`
- Full backward compatibility with old updaters
- Release script support for canary workflow

**Non-Goals:**
- Server-side routing or A/B testing infrastructure
- Client downgrade (forward-only policy)
- Canary TTL or auto-promote
- Canary observability dashboard (SLS queries are sufficient for now)
- Multi-canary tracks (only one canary at a time)

## Decisions

### 1. Embed canary in `latest.json` vs separate `rollout.json`

**Decision**: Embed as an optional `canary` field in `latest.json`.

**Rationale**: Single atomic fetch — the client gets both stable and canary info in one request. No race condition between reading rollout config and version manifest. Old updaters naturally ignore unknown fields via JSON.parse.

**Alternative considered**: Separate `rollout.json` file. Rejected because it doubles fetch requests, introduces race conditions between the two files, and requires old updaters to handle a missing file gracefully.

### 2. Client-side config flags vs server-side user lists

**Decision**: `autoCanary` and `noCanary` boolean flags in client `config.json`, with priority: `noCanary` > `autoCanary` > percentage bucketing.

**Rationale**: No server-side user identity needed. Users can self-select without modifying the server manifest. Keeps the system stateless on the server side (pure OSS static files).

**Alternative considered**: `target_users`/`exclude_users` arrays in `latest.json`. Rejected because it requires maintaining user lists server-side, couples identity to the manifest, and doesn't scale.

### 3. `installId` (UUID) for bucketing

**Decision**: Auto-generated UUID stored in `config.json`, created on first updater run if missing.

**Rationale**: Machine-unique, stable across updates, doesn't depend on user configuration. `hash(installId) % 100` gives uniform distribution and deterministic bucket assignment.

**Alternative considered**: Using `userId` from config. Rejected because userId may not be configured, can change, and is semantically a person, not an installation.

### 4. Fixed bucketing (no version mixing)

**Decision**: `bucket = hash(installId) % 100` — the same installId always lands in the same bucket regardless of canary version.

**Rationale**: Predictable behavior — the "pioneer" group is always the same machines. When a hotfix is needed, the same group tests it, keeping the communication scope small.

**Alternative considered**: Mixing version into the hash (`hash(installId + version) % 100`). Rejected because it shuffles the pioneer group each release, losing the "same people test first" property.

### 5. `hotfix_version` for canary iteration

**Decision**: Numeric field in `latest.json` canary (optional, starts from 1 when first hotfix is needed). Mirrored in client `config.json` under `canary.hotfix_version`.

**Rationale**: Allows iterating on a canary version without bumping the main semver. Ordered comparison (`hotfix_version` 1 < 2 < 3) is straightforward, unlike git_commit hashes which only support equality checks.

**Alternative considered**: Bumping the main version for each hotfix. Rejected because it inflates version numbers and makes the final "promote" version look artificially high.

### 6. Forward-only (no downgrades)

**Decision**: `needsUpdate()` only accepts upgrades. Canary users who hit a bug wait for a hotfix rather than being rolled back to stable.

**Rationale**: Simplifies version state management — no need to handle downgrade-related data/config compatibility issues. Since canary is always a small percentage, the wait window impact is contained. Stop-the-bleed (`percentage=0`) prevents new users from entering canary.

### 7. Try/catch fallback for all canary logic

**Decision**: Entire `resolveTargetVersion()` wrapped in try/catch. Any exception falls back to using the top-level stable version.

**Rationale**: The canary feature must never break the existing update path. Worst case: canary logic fails silently, and the client behaves exactly as today.

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Canary users stuck on buggy version (forward-only) | Small group affected until hotfix | Stop-the-bleed (`percentage=0`) + rapid hotfix via `release.sh --canary --hotfix` |
| `installId` collision (UUID) | Two machines in same bucket | Negligible probability (UUID v4); no functional impact even if it happens |
| Hash distribution skew | Uneven bucket allocation | SHA-256 provides near-uniform distribution; acceptable for 100-bucket granularity |
| Forgotten canary (never promoted) | Small group stuck on old canary indefinitely | Documented as open question — may add TTL warning in future |
| Config.json write failure after canary update | `hotfix_version` not persisted, may re-download same hotfix | Existing behavior is idempotent — re-applying same version is harmless |
| Concurrent stable hotfix during canary | Canary users don't get stable fix | Documented procedure: merge fix into canary, release via `--canary --hotfix` |
