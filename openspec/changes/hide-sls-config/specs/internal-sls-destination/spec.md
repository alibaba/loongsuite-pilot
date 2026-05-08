## ADDED Requirements

### Requirement: Built-in SLS destination
The system SHALL define its default SLS endpoint, project, logstore, and upload mode in TypeScript source code that is bundled with Loongsuite Pilot.

#### Scenario: Config file has no SLS destination
- **WHEN** Loongsuite Pilot loads configuration from a `config.json` without `sls.endpoint`, `sls.project`, or `sls.logstore`
- **THEN** the SLS flusher configuration MUST use the built-in destination values.

### Requirement: User config does not control default destination
The system SHALL NOT use `config.json` values for `sls.endpoint`, `sls.project`, or `sls.logstore` when resolving the default packaged SLS destination.

#### Scenario: Legacy config contains old SLS destination fields
- **WHEN** an installed user's `config.json` still contains `sls.endpoint`, `sls.project`, and `sls.logstore`
- **THEN** Loongsuite Pilot MUST ignore those destination values and use the built-in destination instead.

#### Scenario: Legacy config is preserved on disk
- **WHEN** Loongsuite Pilot starts with legacy SLS destination fields present in `config.json`
- **THEN** startup MUST NOT require deleting or rewriting those fields.

### Requirement: Operator overrides remain supported
The system SHALL continue to support explicit operator-provided SLS destination overrides through environment variables and retained installer flags.

#### Scenario: Environment override is provided
- **WHEN** `SLS_ENDPOINT`, `SLS_PROJECT`, and `SLS_LOGSTORE` are set in the process environment
- **THEN** Loongsuite Pilot MUST use those explicit environment values instead of the built-in destination.

#### Scenario: Installer flags are provided
- **WHEN** an operator runs the installer with explicit `--sls-endpoint`, `--sls-project`, or `--sls-logstore` flags
- **THEN** the installer MUST preserve support for those flags while normal installs omit the built-in default destination from user config.

### Requirement: Non-destination SLS controls remain configurable
The system SHALL continue to honor supported non-destination SLS controls that do not expose internal routing details.

#### Scenario: User disables SLS
- **WHEN** `config.json` contains `sls.enabled` set to `false`
- **THEN** Loongsuite Pilot MUST disable the SLS flusher without requiring removal of the built-in destination.

#### Scenario: User configures SLS batching
- **WHEN** `config.json` contains supported batching controls such as `sls.batchMaxSize` or `sls.flushIntervalMs`
- **THEN** Loongsuite Pilot MUST apply those controls while still using the built-in destination.

### Requirement: Installer omits internal destination from user config
The installer SHALL NOT write the default SLS endpoint, project, or logstore into user-visible `config.json` for normal installs.

#### Scenario: Fresh install writes config
- **WHEN** the installer creates a new `~/.loongsuite-pilot/config.json`
- **THEN** the written file MUST NOT include default `sls.endpoint`, `sls.project`, or `sls.logstore` values.

#### Scenario: Reinstall preserves existing config
- **WHEN** the installer updates an existing `config.json` that already contains legacy SLS destination fields
- **THEN** the installer MUST NOT depend on those fields for runtime behavior and MUST NOT require removing them.

### Requirement: Internal destination supports future obfuscation
The built-in SLS destination SHALL be isolated behind a code module boundary that packaging can later target for obfuscation.

#### Scenario: Build output is prepared for obfuscation
- **WHEN** the TypeScript package is built
- **THEN** the SLS destination values MUST originate from the internal module rather than installer-generated user config.
