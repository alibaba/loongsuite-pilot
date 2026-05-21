## MODIFIED Requirements

### Requirement: SLS endpoint resolution from config and environment

The system SHALL resolve the runtime list of SLS destinations from `config.json` (and environment variables) into an ordered `endpoints[]` array consumed by the SLS flusher, based on the presence of user-provided destination fields and the compile-time constant `__INTERNAL_BUILD__`.

The system SHALL NOT read or use the `sls.destinationOverride` field from config. If the field is present in `config.json`, it SHALL be silently ignored.

The system SHALL never persist the built-in destination (`INTERNAL_SLS_DESTINATION`) to `config.json`; it SHALL be appended in memory only in internal builds.

#### Scenario: Internal build, no user destination fields configured
- **WHEN** `__INTERNAL_BUILD__` is `true`
- **AND** `config.json` has no `sls.project` and no `sls.logstore`, and no `SLS_*` environment variables provide them
- **THEN** the resolver SHALL return `endpoints = [INTERNAL]` populated entirely from `INTERNAL_SLS_DESTINATION`

#### Scenario: Internal build, user destination present — unconditional dual-write
- **WHEN** `__INTERNAL_BUILD__` is `true`
- **AND** `config.json` (or environment variables) provides `sls.project` and `sls.logstore`
- **THEN** the resolver SHALL return `endpoints = [userEndpoint, INTERNAL]` in that order
- **AND** the internal entry SHALL be populated from `INTERNAL_SLS_DESTINATION` constants
- **AND** there SHALL be no configuration option to disable the internal endpoint

#### Scenario: Internal build, user destination present, legacy destinationOverride field exists
- **WHEN** `__INTERNAL_BUILD__` is `true`
- **AND** `config.json` contains `sls.destinationOverride: true` (or any value)
- **AND** user destination fields are present
- **THEN** the resolver SHALL ignore `destinationOverride` and return `endpoints = [userEndpoint, INTERNAL]` (unconditional dual-write)

#### Scenario: External build, no user destination fields configured
- **WHEN** `__INTERNAL_BUILD__` is `false`
- **AND** no user destination fields are provided
- **THEN** the resolver SHALL return an empty `endpoints` array
- **AND** SLS SHALL be disabled (no internal fallback)

#### Scenario: External build, user destination present
- **WHEN** `__INTERNAL_BUILD__` is `false`
- **AND** user destination fields are provided
- **THEN** the resolver SHALL return `endpoints = [userEndpoint]` containing only the user destination
- **AND** the internal destination SHALL NOT be appended

#### Scenario: External build, destinationOverride field exists
- **WHEN** `__INTERNAL_BUILD__` is `false`
- **AND** `config.json` contains `sls.destinationOverride` (any value)
- **THEN** the resolver SHALL ignore the field entirely

### Requirement: Resolver dedupes destinations targeting the same SLS triple

The resolver SHALL collapse entries in the assembled `endpoints[]` array whose normalized `(endpoint, project, logstore)` triple is identical, keeping only the first entry. Normalization SHALL trim trailing slashes from the endpoint URL, lowercase the host, and prepend `https://` if no scheme is present.

#### Scenario: User fields coincide with internal constants in internal build
- **WHEN** `__INTERNAL_BUILD__` is `true`
- **AND** user destination fields equal the internal constants (`endpoint: 'https://cn-heyuan.log.aliyuncs.com'`, `project: 'ai-coding-devops'`, `logstore: 'loongsuite_pilot_for_ai_coding'`)
- **THEN** the resolver SHALL return `endpoints` of length 1 (the user entry wins), NOT length 2
- **AND** SHALL NOT cause double-write to the same logstore

#### Scenario: Endpoint URL differs only in trailing slash or scheme
- **WHEN** the user endpoint is `cn-heyuan.log.aliyuncs.com/` (no scheme, trailing slash) and the internal endpoint is `https://cn-heyuan.log.aliyuncs.com`, with the same project and logstore
- **THEN** the resolver SHALL treat them as the same destination after normalization and dedupe to length 1

## REMOVED Requirements

### Requirement: destinationOverride field controls dual-write behavior
**Reason**: Replaced by compile-time `__INTERNAL_BUILD__` constant. Internal builds always dual-write; external builds never include internal destination. There is no runtime toggle.
**Migration**: Users with `destinationOverride` in their `config.json` need take no action — the field is silently ignored after upgrade. Internal build users who had `destinationOverride: true` (user-only mode) will automatically begin dual-writing.
