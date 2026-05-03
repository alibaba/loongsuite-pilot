## ADDED Requirements

### Requirement: Discover Qoder CLI session segment files
The system SHALL discover Qoder CLI native segment logs matching `~/.qoder/logs/sessions/**/segments/*.jsonl` and SHALL ignore unrelated files outside `segments` directories.

#### Scenario: Segment files are discovered across session directories
- **WHEN** multiple Qoder CLI sessions exist under `~/.qoder/logs/sessions/<cwd-key>/<session-id>/segments/`
- **THEN** the collector includes each matching `.jsonl` segment file in polling

#### Scenario: Non-segment JSONL files are ignored
- **WHEN** JSONL files exist elsewhere under `~/.qoder/logs/sessions`
- **THEN** the collector does not process those files

### Requirement: Avoid startup historical backfill
The system SHALL baseline existing Qoder CLI segment files at their current byte offsets when the Qoder CLI session input starts, so historical lines present before startup are not emitted.

#### Scenario: Existing segment file is baselined
- **WHEN** the collector starts and a Qoder CLI segment file already contains JSONL records
- **THEN** the collector records the current offset and emits no entries for those existing records

#### Scenario: Newly appended line is collected after startup
- **WHEN** a supported token usage line is appended to a baselined segment file after startup
- **THEN** the collector emits one `AgentActivityEntry` for that appended line

### Requirement: Collect newly created runtime segments from the beginning
The system SHALL read segment files first discovered after startup from offset 0.

#### Scenario: Runtime-created segment file is read completely
- **WHEN** a new matching segment file appears while the collector is running
- **THEN** the collector processes supported records from the beginning of that file

### Requirement: Emit token usage entries from model responses
The system SHALL process `model.response.completed` records and map their token usage fields into normalized `AgentActivityEntry` records with `agent.type` set to `qoder-cli`.

#### Scenario: Model response token usage is mapped
- **WHEN** a `model.response.completed` record contains `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`
- **THEN** the emitted entry contains `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_tokens`, and `usage.cache_write_tokens` with the corresponding values

#### Scenario: Model and request identifiers are mapped
- **WHEN** a `model.response.completed` record contains `request_id`, `turn_id`, `loop_id`, and `data.model`
- **THEN** the emitted entry contains `request.id`, `turn.id`, `step.id`, `request.model`, and `response.model`

### Requirement: Derive session identity from segment path
The system SHALL derive `session.id` from the directory immediately above the `segments` directory when the source record does not include a session id.

#### Scenario: Session id is derived from path
- **WHEN** the collector processes `~/.qoder/logs/sessions/<cwd-key>/<session-id>/segments/<segment>.jsonl`
- **THEN** the emitted entry has `session.id` equal to `<session-id>`

### Requirement: Ignore non-token Qoder event types
The system SHALL ignore Qoder segment records that are not token-relevant supported event types.

#### Scenario: Lifecycle event is ignored
- **WHEN** the collector reads a `turn.started`, `session.config.loaded`, or other unsupported record type
- **THEN** no `AgentActivityEntry` is emitted for that record

### Requirement: Use deterministic event ids
The system SHALL generate deterministic `event.id` values for Qoder CLI session token entries from stable source fields.

#### Scenario: Same source row yields same event id
- **WHEN** the same segment path, sequence number, event type, and request id are mapped more than once
- **THEN** the emitted entries have the same `event.id`

### Requirement: Reuse configured output flushers
The system SHALL send emitted Qoder CLI session token entries through the existing input manager and configured local JSONL and SLS flushers.

#### Scenario: Entry flows to existing dispatch path
- **WHEN** the Qoder CLI session input emits token usage entries
- **THEN** those entries are dispatched through the existing flusher configuration without a separate output path
