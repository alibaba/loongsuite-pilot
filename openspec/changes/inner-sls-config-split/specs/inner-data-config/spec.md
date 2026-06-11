## ADDED Requirements

### Requirement: Inner data_config.json file structure
The system SHALL support a dedicated config file at `{dataDir}/configs/inner/data_config.json` for storing built-in (内置) SLS endpoints for 集团版 installations. The file SHALL contain a `sls` field as an array of `SlsEndpointEntry` objects. The file is optional — if missing or unreadable, the system SHALL proceed without error.

#### Scenario: data_config.json exists with valid SLS entries
- **WHEN** `configs/inner/data_config.json` exists and contains a valid `sls` array
- **THEN** ConfigLoader SHALL parse each entry using the same `parseSlsEndpointEntry()` logic as config.json

#### Scenario: data_config.json does not exist
- **WHEN** `configs/inner/data_config.json` does not exist
- **THEN** ConfigLoader SHALL proceed normally, using only config.json SLS endpoints

#### Scenario: data_config.json is malformed
- **WHEN** `configs/inner/data_config.json` exists but contains invalid JSON
- **THEN** ConfigLoader SHALL log a warning and proceed using only config.json SLS endpoints

### Requirement: SLS endpoint merging from dual sources
ConfigLoader SHALL merge SLS endpoints from `config.json` and `configs/inner/data_config.json` into a single deduplicated endpoint list. Endpoints from `config.json` SHALL take precedence — during deduplication, the first occurrence (config.json endpoints) SHALL be kept.

#### Scenario: Both files have SLS endpoints with no overlap
- **WHEN** config.json has a user SLS endpoint AND data_config.json has the internal SLS endpoint
- **THEN** the final endpoints list SHALL contain both endpoints

#### Scenario: Both files have the same endpoint (deduplication)
- **WHEN** config.json and data_config.json both contain an endpoint with the same `endpoint|project|logstore` combination
- **THEN** only the config.json version SHALL be kept (dedup preserves first occurrence)

#### Scenario: config.json has no SLS, data_config.json has internal SLS
- **WHEN** config.json has no `sls` field AND data_config.json has the internal SLS endpoint
- **THEN** the final endpoints list SHALL contain only the internal SLS endpoint from data_config.json

#### Scenario: Neither file has SLS configuration
- **WHEN** neither config.json nor data_config.json has SLS configuration
- **THEN** SLS SHALL be disabled (empty endpoints list)

### Requirement: Installer-inner writes to split targets
The inner installation script (`installer-inner.sh`) SHALL write the built-in SLS endpoint to `configs/inner/data_config.json` instead of `config.json`. User-specified SLS configuration SHALL continue to be written to `config.json`.

#### Scenario: Install with user-specified SLS
- **WHEN** user provides `--sls-project` and `--sls-logstore` during inner installation
- **THEN** user SLS endpoint SHALL be written to `config.json` `sls` field AND internal SLS SHALL be written to `configs/inner/data_config.json`

#### Scenario: Install without user-specified SLS
- **WHEN** user does not provide SLS arguments during inner installation
- **THEN** `config.json` SHALL NOT contain an `sls` field AND internal SLS SHALL be written to `configs/inner/data_config.json`

#### Scenario: Installer creates configs/inner directory
- **WHEN** inner installation runs
- **THEN** the installer SHALL create `{dataDir}/configs/inner/` directory if it does not exist

### Requirement: Migration of existing internal SLS from config.json
The migration script SHALL move built-in SLS endpoints from `config.json` to `configs/inner/data_config.json` during upgrade. The migration SHALL be idempotent.

#### Scenario: config.json has internal SLS in array format
- **WHEN** config.json `sls` is an array containing an entry with `project === 'ai-coding-devops'` or `name === 'internal-sls'`
- **THEN** migration SHALL remove the internal entry from the array, write it to `configs/inner/data_config.json`, and keep remaining user entries in config.json

#### Scenario: config.json has only internal SLS as flat object
- **WHEN** config.json `sls` is a flat object with `project === 'ai-coding-devops'`
- **THEN** migration SHALL remove the `sls` field from config.json entirely AND write the internal endpoint to `configs/inner/data_config.json`

#### Scenario: config.json has internal SLS in array, becomes empty after removal
- **WHEN** config.json `sls` array contains only the internal endpoint (no user endpoints)
- **THEN** migration SHALL remove the entire `sls` field from config.json AND write the internal endpoint to `configs/inner/data_config.json`

#### Scenario: config.json has dual-write array (user + internal)
- **WHEN** config.json `sls` is `[userEndpoint, internalEndpoint]`
- **THEN** migration SHALL keep `[userEndpoint]` in config.json AND write the internal endpoint to `configs/inner/data_config.json`

#### Scenario: data_config.json already exists with correct content
- **WHEN** `configs/inner/data_config.json` already exists with the internal SLS endpoint AND config.json has no internal SLS
- **THEN** migration SHALL overwrite data_config.json with the latest hardcoded values (to allow endpoint URL updates in future versions) and make no changes to config.json

#### Scenario: Migration is idempotent
- **WHEN** migration runs multiple times
- **THEN** the end state SHALL be identical to running migration once

### Requirement: Migration atomicity
The migration script SHALL ensure data integrity by writing `configs/inner/data_config.json` successfully before modifying `config.json`. Both writes SHALL use atomic file operations (write to temp file, then rename).

#### Scenario: data_config.json write fails
- **WHEN** writing to `configs/inner/data_config.json` fails (e.g., permission error)
- **THEN** config.json SHALL NOT be modified, preserving the internal SLS endpoint in its original location

#### Scenario: config.json write fails after data_config.json succeeds
- **WHEN** data_config.json is written successfully but config.json write fails
- **THEN** next startup will load internal SLS from both files, but deduplication ensures no double-writing to SLS

### Requirement: External (commercial) builds unaffected
Commercial/external installations SHALL NOT be affected by this change. The `configs/inner/data_config.json` file SHALL never be created or read by external installations. The `migrate-internal-config.js` script continues to be stripped from external packages by `package.sh --external`.

#### Scenario: External installation has no data_config.json
- **WHEN** running an external/commercial build
- **THEN** ConfigLoader SHALL not attempt to read `configs/inner/data_config.json` (or if it does, the file will not exist and it will be silently skipped)
