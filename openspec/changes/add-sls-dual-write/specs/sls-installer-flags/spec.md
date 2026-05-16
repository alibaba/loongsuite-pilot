## ADDED Requirements

### Requirement: Installer accepts --default-sls-override flag

Both `deploy/loongsuite-pilot-installer.sh` and `deploy/loongsuite-pilot-installer-inner.sh` SHALL accept a `--default-sls-override` flag with a boolean value (`true` or `false`). The default value SHALL be `true`.

The flag SHALL only be persisted into `~/.loongsuite-pilot/config.json` when at least one of `--sls-endpoint`, `--sls-project`, or `--sls-logstore` is also supplied in the same install invocation.

#### Scenario: Flag accepts --default-sls-override=false
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --sls-project P --sls-logstore L --default-sls-override=false`
- **THEN** the installer SHALL parse the flag without error
- **AND** SHALL write `sls.destinationOverride: false` into `~/.loongsuite-pilot/config.json`
- **AND** SHALL also write the user-provided `sls.endpoint`, `sls.project`, `sls.logstore` fields

#### Scenario: Flag accepts --default-sls-override=true
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --sls-project P --sls-logstore L --default-sls-override=true`
- **THEN** the installer SHALL write `sls.destinationOverride: true` into `~/.loongsuite-pilot/config.json`

#### Scenario: Flag omitted defaults to true with --sls-* args
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --sls-project P --sls-logstore L` (no `--default-sls-override`)
- **THEN** the installer SHALL write `sls.destinationOverride: true` into `~/.loongsuite-pilot/config.json` (preserving today's behavior)

#### Scenario: Flag without --sls-* args is a no-op with warning
- **WHEN** the user invokes `bash loongsuite-pilot-installer.sh install --default-sls-override=false` without any `--sls-*` flag
- **THEN** the installer SHALL emit a warning explaining that the flag has no effect without `--sls-*` arguments
- **AND** SHALL NOT write `sls.destinationOverride` into `~/.loongsuite-pilot/config.json`
- **AND** the installation SHALL otherwise complete normally (built-in destination only)

### Requirement: Installer accepts --default-sls-override values robustly

The installer SHALL accept the flag in both space-separated and `=`-separated forms (`--default-sls-override false` and `--default-sls-override=false`) and SHALL reject other values with a clear error.

#### Scenario: Space-separated form
- **WHEN** the user invokes `... --sls-project P --sls-logstore L --default-sls-override false`
- **THEN** the installer SHALL parse the value as `false`

#### Scenario: Invalid value rejected
- **WHEN** the user invokes `... --default-sls-override=maybe`
- **THEN** the installer SHALL print an error indicating the flag must be `true` or `false`
- **AND** SHALL exit with a non-zero status

### Requirement: Installer never writes the internal destination to config.json

The installer SHALL NOT write any field referring to the internal destination (`INTERNAL_SLS_DESTINATION`) into `~/.loongsuite-pilot/config.json`. Only user-provided values and the `destinationOverride` flag SHALL appear in the `sls` block.

#### Scenario: Dual-write installation
- **WHEN** the user installs with `--sls-project P --sls-logstore L --default-sls-override=false`
- **THEN** the resulting `config.json` `sls` block SHALL contain `endpoint` (if provided), `project: 'P'`, `logstore: 'L'`, and `destinationOverride: false`
- **AND** SHALL NOT contain the constants `ai-coding-devops`, `loongsuite_pilot_for_ai_coding`, or `cn-heyuan.log.aliyuncs.com` originating from the internal destination
