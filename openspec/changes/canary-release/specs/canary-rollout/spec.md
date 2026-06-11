## ADDED Requirements

### Requirement: Canary manifest parsing
The updater SHALL parse an optional `canary` field from `latest.json`. The `canary` field SHALL conform to the `CanaryManifest` interface (extending `VersionManifest` with `rollout_percentage: number` and optional `hotfix_version?: number`). If the `canary` field is absent, null, or malformed, the updater SHALL treat it as "no canary" and use the top-level stable version.

#### Scenario: latest.json contains valid canary field
- **WHEN** the fetched `latest.json` contains a `canary` object with valid `version`, `package_url`, `sha256`, and `rollout_percentage` fields
- **THEN** the updater SHALL pass the canary manifest to `resolveTargetVersion()` for routing

#### Scenario: latest.json has no canary field
- **WHEN** the fetched `latest.json` does not contain a `canary` field
- **THEN** the updater SHALL use the top-level stable version (existing behavior)

#### Scenario: canary field is malformed
- **WHEN** the `canary` field exists but is missing required fields (e.g., no `rollout_percentage`)
- **THEN** the updater SHALL log a warning and fall back to the top-level stable version

### Requirement: Deterministic client bucketing
The system SHALL compute a deterministic bucket for each installation using `hash(installId + canaryVersion) % 100`, where `hash` is SHA-256. The bucket value SHALL be an integer in `[0, 99]`. The same `installId + canaryVersion` combination SHALL always produce the same bucket value. Different canary versions will produce different bucket distributions, ensuring different machines are selected as canary pioneers across releases. Hotfix releases do not change the canary version, so the same machines receive the fix.

#### Scenario: Bucket calculation
- **WHEN** `deterministicBucket("a3f8c1d2-7b4e-4f9a-b2c1-e5d6f7a8b9c0", "1.0.36")` is called
- **THEN** the function SHALL return a stable integer in `[0, 99]` derived from `SHA256("a3f8c1d2-..." + "1.0.36") % 100`

#### Scenario: Bucket stability across calls
- **WHEN** `deterministicBucket` is called multiple times with the same `installId` and `version`
- **THEN** the result SHALL be identical every time

#### Scenario: Different versions produce different buckets
- **WHEN** `deterministicBucket` is called with the same `installId` but different canary versions
- **THEN** the results MAY differ, distributing canary risk across different machines over time

### Requirement: Version routing via resolveTargetVersion
The updater SHALL implement `resolveTargetVersion()` that decides whether the client should use the stable or canary version. The decision priority SHALL be: (1) `noCanary=true` → stable, (2) `autoCanary=true` → canary, (3) `bucket < rollout_percentage` → canary, (4) otherwise → stable.

#### Scenario: noCanary flag set
- **WHEN** client `config.json` has `noCanary: true` and a canary is available
- **THEN** `resolveTargetVersion()` SHALL return the stable version with `channel="stable"`

#### Scenario: autoCanary flag set
- **WHEN** client `config.json` has `autoCanary: true`, `noCanary` is not set, and a canary is available
- **THEN** `resolveTargetVersion()` SHALL return the canary version with `channel="canary"`, regardless of `rollout_percentage`

#### Scenario: Client bucket within rollout percentage
- **WHEN** `noCanary` and `autoCanary` are not set, and `bucket=23` and `rollout_percentage=30`
- **THEN** `resolveTargetVersion()` SHALL return the canary version with `channel="canary"` (23 < 30)

#### Scenario: Client bucket outside rollout percentage
- **WHEN** `noCanary` and `autoCanary` are not set, and `bucket=78` and `rollout_percentage=30`
- **THEN** `resolveTargetVersion()` SHALL return the stable version with `channel="stable"` (78 >= 30)

#### Scenario: rollout_percentage is 0
- **WHEN** `rollout_percentage=0` and `autoCanary` is not set
- **THEN** `resolveTargetVersion()` SHALL return stable for all clients (no bucket < 0)

### Requirement: hotfix_version comparison for canary updates
When the resolved channel is `canary` and the remote canary version equals the local version, `needsUpdate()` SHALL compare `hotfix_version`. If the remote `hotfix_version` is greater than the locally stored `canary.hotfix_version` in `config.json`, the update SHALL proceed.

#### Scenario: Canary hotfix available
- **WHEN** local version is `1.0.36`, channel is `canary`, remote canary version is `1.0.36`, remote `hotfix_version=2`, and local `config.json` `canary.hotfix_version=1`
- **THEN** `needsUpdate()` SHALL return `true`

#### Scenario: Canary hotfix already applied
- **WHEN** local version is `1.0.36`, channel is `canary`, remote canary version is `1.0.36`, remote `hotfix_version=1`, and local `config.json` `canary.hotfix_version=1`
- **THEN** `needsUpdate()` SHALL return `false`

#### Scenario: Stable channel ignores hotfix_version
- **WHEN** channel is `stable` and the versions match
- **THEN** `needsUpdate()` SHALL NOT check `hotfix_version` (only git_commit rebuild check applies)

### Requirement: Persist canary state after update
After a successful canary update, the updater SHALL write the remote `hotfix_version` (defaulting to 0 if absent) to `config.json` at `canary.hotfix_version`.

#### Scenario: Write hotfix_version after canary update
- **WHEN** a canary update completes successfully and remote `hotfix_version=2`
- **THEN** the updater SHALL write `{"canary": {"hotfix_version": 2}}` to `config.json`

#### Scenario: Write default hotfix_version when not specified
- **WHEN** a canary update completes successfully and the remote canary has no `hotfix_version` field
- **THEN** the updater SHALL write `{"canary": {"hotfix_version": 0}}` to `config.json`

### Requirement: installId auto-generation
The updater SHALL ensure `installId` exists in `config.json` before performing canary routing. If `installId` is missing, the updater SHALL generate a UUID v4 and persist it to `config.json`.

#### Scenario: installId missing on first run
- **WHEN** `config.json` does not contain an `installId` field
- **THEN** the updater SHALL generate a UUID v4, write it to `config.json`, and use it for bucketing

#### Scenario: installId already present
- **WHEN** `config.json` already contains `installId: "abc-123"`
- **THEN** the updater SHALL use the existing value without modification

### Requirement: Canary fallback safety
All canary-related logic (manifest parsing, bucketing, version routing) SHALL be wrapped in try/catch. Any exception SHALL cause the updater to fall back to the top-level stable version, logging a warning.

#### Scenario: Exception in resolveTargetVersion
- **WHEN** `resolveTargetVersion()` throws an error (e.g., hash function failure)
- **THEN** the updater SHALL log the error, use the stable version, and continue the update check normally

### Requirement: Canary update logging
The updater SHALL log the rollout decision with channel, target version, bucket value, and rollout percentage for observability.

#### Scenario: Log canary resolution
- **WHEN** `resolveTargetVersion()` completes
- **THEN** the updater SHALL log: `rollout resolved: channel=<channel>, target=<version>, bucket=<N>, percentage=<N>`

### Requirement: AutoUpdateConfig extension
`buildAutoUpdateConfig()` SHALL include `installId`, `autoCanary`, `noCanary`, and `canary.hotfix_version` from the loaded config, making them available to the updater process.

#### Scenario: Config fields passed to updater
- **WHEN** `config.json` contains `installId`, `autoCanary: true`, and `canary.hotfix_version: 1`
- **THEN** `buildAutoUpdateConfig()` SHALL include these values in the returned `AutoUpdateConfig` object

### Requirement: CanaryManifest type definition
The types module SHALL export a `CanaryManifest` interface extending `VersionManifest` with `rollout_percentage: number` and `hotfix_version?: number`. The `AutoUpdateConfig` interface SHALL be extended with `installId?: string`, `autoCanary?: boolean`, `noCanary?: boolean`, and `canaryHotfixVersion?: number`.

#### Scenario: Type availability
- **WHEN** code imports from the types module
- **THEN** `CanaryManifest` and extended `AutoUpdateConfig` types SHALL be available
