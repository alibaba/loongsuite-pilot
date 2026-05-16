## ADDED Requirements

### Requirement: SLS endpoint resolution from config and environment

The system SHALL resolve the runtime list of SLS destinations from `config.json` (and environment variables) into an ordered `endpoints[]` array consumed by the SLS flusher, according to the presence of user-provided destination fields and the value of `sls.destinationOverride`.

The system SHALL treat `sls.destinationOverride` as `true` when the field is omitted but user-provided destination fields are present.

The system SHALL never persist the built-in destination (`INTERNAL_SLS_DESTINATION`) to `config.json`; it SHALL be appended in memory only when dual-write is selected.

#### Scenario: No user destination fields configured
- **WHEN** `config.json` has no `sls.endpoint`, no `sls.project`, and no `sls.logstore`, and no `SLS_*` environment variables provide them
- **THEN** the resolver SHALL return `endpoints = [INTERNAL]` populated entirely from `INTERNAL_SLS_DESTINATION`
- **AND** the value of `sls.destinationOverride` SHALL be ignored

#### Scenario: User destination present, destinationOverride defaults to true
- **WHEN** `config.json` has `sls.endpoint`, `sls.project`, `sls.logstore` populated and `sls.destinationOverride` is omitted
- **THEN** the resolver SHALL return `endpoints = [USER]` containing only the user destination
- **AND** the internal destination SHALL NOT be appended

#### Scenario: User destination present, destinationOverride explicitly true
- **WHEN** `config.json` has user destination fields and `sls.destinationOverride: true`
- **THEN** the resolver SHALL return `endpoints = [USER]` only

#### Scenario: User destination present, destinationOverride false enables dual-write
- **WHEN** `config.json` has user destination fields (different from the internal constants) and `sls.destinationOverride: false`
- **THEN** the resolver SHALL return `endpoints = [USER, INTERNAL]` in that order
- **AND** the internal entry SHALL be populated from `INTERNAL_SLS_DESTINATION` constants
- **AND** the internal entry's `name` SHALL be `internal-sls`

#### Scenario: destinationOverride false without user destination
- **WHEN** `config.json` has `sls.destinationOverride: false` but no user destination fields are provided
- **THEN** the resolver SHALL behave as if no user destination is configured and return `endpoints = [INTERNAL]`

### Requirement: Resolver dedupes destinations targeting the same SLS triple

The resolver SHALL collapse entries in the assembled `endpoints[]` array whose normalized `(endpoint, project, logstore)` triple is identical, keeping only the first entry. Normalization SHALL trim trailing slashes from the endpoint URL, lowercase the host, and prepend `https://` if no scheme is present.

#### Scenario: User fields coincide with internal constants under default override
- **WHEN** `config.json` has user destination fields equal to the internal constants (e.g. `endpoint: 'https://cn-heyuan.log.aliyuncs.com'`, `project: 'ai-coding-devops'`, `logstore: 'loongsuite_pilot_for_ai_coding'`) and `destinationOverride` is omitted (default true)
- **THEN** the resolver SHALL return a single endpoint, NOT a duplicate
- **AND** the surviving endpoint SHALL retain the user-leg `name` and any user-supplied credentials

#### Scenario: User fields coincide with internal constants under dual-write
- **WHEN** `config.json` has user destination fields equal to the internal constants and `destinationOverride: false`
- **THEN** the resolver SHALL return `endpoints` of length 1 (the user entry), NOT length 2
- **AND** SHALL NOT cause double-write to the same logstore

#### Scenario: Endpoint URL differs only in trailing slash or scheme
- **WHEN** the user endpoint is `cn-heyuan.log.aliyuncs.com/` (no scheme, trailing slash) and the internal endpoint is `https://cn-heyuan.log.aliyuncs.com`, with the same project and logstore
- **THEN** the resolver SHALL treat them as the same destination after normalization and dedupe to length 1

### Requirement: SlsEndpoint is a self-contained destination

Each `SlsEndpoint` SHALL carry every field needed to send a batch to its SLS target, independent of other endpoints in the same flusher.

#### Scenario: Per-endpoint URL, mode, and credentials
- **WHEN** the resolver constructs an `SlsEndpoint`
- **THEN** the endpoint SHALL include `name`, `endpoint` (base URL), `project`, `logstore`, `kind`, `mode`, optional `accessKeyId`, optional `accessKeySecret`, and optional `redact`
- **AND** an endpoint with `mode: 'ak'` SHALL have non-empty `accessKeyId` and `accessKeySecret`
- **AND** an endpoint with `mode: 'webtracking'` SHALL ignore `accessKeyId` and `accessKeySecret`

#### Scenario: Two endpoints in different regions and modes
- **WHEN** dual-write is enabled and the user destination uses `mode: 'ak'` with `endpoint: 'https://cn-shanghai.log.aliyuncs.com'` while the internal destination uses `mode: 'webtracking'` with `endpoint: 'https://cn-heyuan.log.aliyuncs.com'`
- **THEN** the resolver SHALL produce two `SlsEndpoint` entries each carrying their own `endpoint` URL and `mode`
- **AND** the flusher SHALL be able to dispatch to both without sharing connection state

### Requirement: SLS flusher dispatches per endpoint

The SLS flusher SHALL iterate the resolved `endpoints[]` array, choosing the transport (webtracking POST vs AK SDK) based on the per-endpoint `mode` field rather than a flusher-wide mode.

#### Scenario: Webtracking endpoint
- **WHEN** an `SlsEndpoint` has `mode: 'webtracking'`
- **THEN** the flusher SHALL POST to `<endpoint.endpoint>` with project subdomain rewriting and the standard `x-log-*` headers
- **AND** SHALL NOT instantiate an `ALY` AK client for this endpoint

#### Scenario: AK endpoint
- **WHEN** an `SlsEndpoint` has `mode: 'ak'`, plus valid `accessKeyId` and `accessKeySecret`
- **THEN** the flusher SHALL invoke `postLogStoreLogs` via an `ALY` client constructed (or reused from a per-endpoint cache keyed by `endpoint.name`) with that endpoint's URL and credentials
- **AND** SHALL NOT use webtracking for this endpoint

#### Scenario: Failure on one endpoint does not block the other
- **WHEN** sending to two endpoints and one endpoint's send returns a non-retryable error
- **THEN** the other endpoint SHALL still receive the batch
- **AND** only the failing endpoint's batch SHALL be persisted to its failed-log file

### Requirement: Failed-log filenames are per-endpoint

The flusher SHALL persist failed batches to a file keyed by `endpoint.name` so that two endpoints with the same `kind` value do not share the same file.

#### Scenario: Two agentActivity endpoints write to separate files
- **WHEN** the user destination (`name: 'user-sls'`) and the internal destination (`name: 'internal-sls'`) both fail to send
- **THEN** the user batch SHALL be appended to `<failedLogDir>/user-sls.jsonl`
- **AND** the internal batch SHALL be appended to `<failedLogDir>/internal-sls.jsonl`
- **AND** each line SHALL still include the `kind` value within its JSON payload
