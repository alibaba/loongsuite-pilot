## REMOVED Requirements

### Requirement: Installer accepts --default-sls-override flag
**Reason**: The `--default-sls-override` flag is removed because the internal build now unconditionally dual-writes. There is no user-facing toggle for controlling whether the internal logstore receives data. The compile-time `__INTERNAL_BUILD__` constant replaces this runtime configuration.
**Migration**: Users who previously used `--default-sls-override=false` to enable dual-write need take no action — dual-write is now automatic in internal builds. Users who relied on `--default-sls-override=true` (or omitted the flag) to prevent dual-write cannot do so after upgrade; this is the intended product policy ("集团内 100% 发内部 logstore").

### Requirement: Installer accepts --default-sls-override values robustly
**Reason**: The `--default-sls-override` flag is removed entirely. No value parsing is needed.
**Migration**: Remove all references to `--default-sls-override` from automation scripts and documentation.

### Requirement: Installer never writes the internal destination to config.json
**Reason**: This requirement remains valid but the mechanism changes. The installer no longer writes `destinationOverride` to `config.json` because the field no longer exists. The constraint that the internal destination is never persisted to `config.json` continues to hold — it is still appended in memory only by the runtime.
**Migration**: No action needed. The installer continues to write only user-provided SLS fields (`endpoint`, `project`, `logstore`, `accessKeyId`, `accessKeySecret`, `mode`) to `config.json`.

## MODIFIED Requirements

### Requirement: Installer writes SLS configuration to config.json

Both `deploy/loongsuite-pilot-installer.sh` and `deploy/loongsuite-pilot-installer-inner.sh` SHALL write user-provided SLS destination fields to `~/.loongsuite-pilot/config.json` when `--sls-*` arguments are supplied.

The installer SHALL NOT write a `destinationOverride` field to `config.json`.

The installer SHALL NOT accept or parse a `--default-sls-override` argument. If a user passes `--default-sls-override`, the installer SHALL treat it as an unknown argument and exit with an error.

#### Scenario: Install with SLS arguments writes user fields only
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --sls-project P --sls-logstore L --sls-endpoint E`
- **THEN** the installer SHALL write `sls.project: 'P'`, `sls.logstore: 'L'`, `sls.endpoint: 'E'` into `config.json`
- **AND** SHALL NOT write `sls.destinationOverride` into `config.json`

#### Scenario: Install without SLS arguments produces no sls block
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install` without any `--sls-*` argument
- **THEN** the installer SHALL NOT write an `sls` block into `config.json`

#### Scenario: Legacy --default-sls-override argument is rejected
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --default-sls-override=false`
- **THEN** the installer SHALL print an error indicating the argument is no longer supported
- **AND** SHALL exit with a non-zero status
