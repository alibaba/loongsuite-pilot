## ADDED Requirements

### Requirement: Canary release via release.sh
`release.sh` SHALL support a `--canary` flag that creates a canary release. When `--canary` is specified, the script SHALL bump the version (default patch, overridable with `--minor` / `--major`), build the package, and upload it in canary mode (updating the `canary` field in `latest.json` with `rollout_percentage=0`). The top-level stable fields in `latest.json` SHALL NOT be modified.

#### Scenario: Create a new canary release (default patch bump)
- **WHEN** `release.sh --canary` is executed and current version is `1.0.35`
- **THEN** the script SHALL bump to `1.0.36`, build, upload the tarball, set `latest.json` canary field to version `1.0.36` with `rollout_percentage=0`, and leave the top-level stable version as `1.0.35`

#### Scenario: Create a canary release with minor bump
- **WHEN** `release.sh --canary --minor` is executed and current version is `1.0.35`
- **THEN** the script SHALL bump to `1.1.0` and create a canary release with that version

#### Scenario: Create a canary release with explicit version
- **WHEN** `release.sh --canary --version 2.0.0` is executed
- **THEN** the script SHALL create a canary release with version `2.0.0`

### Requirement: Canary hotfix via release.sh
`release.sh` SHALL support `--canary --hotfix` to publish a hotfix for an existing canary. The script SHALL NOT bump the version number. Instead, it SHALL read the current `hotfix_version` from `latest.json` canary field, increment it by 1 (or set to 1 if absent), rebuild the package, and upload it. The script SHALL error if no canary currently exists in `latest.json`.

#### Scenario: First hotfix for a canary
- **WHEN** `release.sh --canary --hotfix` is executed and `latest.json` has a canary with no `hotfix_version`
- **THEN** the script SHALL rebuild the current canary version, set `hotfix_version=1`, and upload

#### Scenario: Subsequent hotfix
- **WHEN** `release.sh --canary --hotfix` is executed and `latest.json` canary has `hotfix_version=2`
- **THEN** the script SHALL rebuild, set `hotfix_version=3`, and upload

#### Scenario: Hotfix without existing canary
- **WHEN** `release.sh --canary --hotfix` is executed and `latest.json` has no canary field
- **THEN** the script SHALL print an error message and exit with non-zero status

### Requirement: Upload script canary mode
`upload.sh` SHALL support a canary mode. In canary mode, the script SHALL update only the `canary` field in `latest.json` (setting version, git_commit, package_url, sha256, released_at, and rollout_percentage), preserving the top-level stable fields unchanged.

#### Scenario: Upload in canary mode
- **WHEN** `upload.sh` runs in canary mode with version `1.0.36`
- **THEN** `latest.json` on OSS SHALL have the top-level stable version unchanged and the `canary` field set to the new version info with `rollout_percentage=0`

#### Scenario: Upload in normal mode
- **WHEN** `upload.sh` runs in normal (non-canary) mode
- **THEN** `latest.json` SHALL be updated as today — top-level fields updated, no canary field changes

### Requirement: Rollout percentage control
`rollout.sh` SHALL accept `--percentage N` (where N is 0-100) to update the `rollout_percentage` in the canary field of `latest.json`. The script SHALL error if no canary exists.

#### Scenario: Set rollout to 5%
- **WHEN** `rollout.sh --percentage 5` is executed and a canary exists
- **THEN** `latest.json` canary `rollout_percentage` SHALL be updated to `5`

#### Scenario: Stop the bleed
- **WHEN** `rollout.sh --percentage 0` is executed
- **THEN** `latest.json` canary `rollout_percentage` SHALL be set to `0`, preventing any new clients from entering canary

#### Scenario: No canary exists
- **WHEN** `rollout.sh --percentage 20` is executed and `latest.json` has no canary field
- **THEN** the script SHALL print an error and exit with non-zero status

### Requirement: Promote canary to stable
`rollout.sh` SHALL accept `--promote` to promote the current canary to stable. This SHALL copy the canary's version, git_commit, package_url, sha256, and released_at to the top-level fields and remove the canary field (set to null or delete).

#### Scenario: Promote canary
- **WHEN** `rollout.sh --promote` is executed and canary version is `1.0.36`
- **THEN** `latest.json` top-level version SHALL become `1.0.36`, and the `canary` field SHALL be removed/null

#### Scenario: Promote without canary
- **WHEN** `rollout.sh --promote` is executed and no canary exists
- **THEN** the script SHALL print an error and exit with non-zero status
