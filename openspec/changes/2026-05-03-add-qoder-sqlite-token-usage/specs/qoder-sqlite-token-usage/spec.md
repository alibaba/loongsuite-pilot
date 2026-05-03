## ADDED Requirements

### Requirement: Collect Qoder SQLite token usage incrementally
The system SHALL collect token usage from Qoder's local SQLite `chat_message` table using an input based on `BaseSqliteInput`.

#### Scenario: New token rows are collected
- **WHEN** the Qoder SQLite database contains `chat_message` rows with `rowid` greater than the stored cursor and non-empty valid `token_info`
- **THEN** the input emits one agent activity entry for each eligible row

#### Scenario: Cursor advances by rowid
- **WHEN** eligible rows are collected from the Qoder SQLite database
- **THEN** the input records the maximum collected SQLite `rowid` as its cursor

#### Scenario: Already collected rows are skipped
- **WHEN** the Qoder SQLite input runs after a cursor has been stored
- **THEN** rows with `rowid` less than or equal to the stored cursor are not emitted again

### Requirement: Map Qoder token fields to usage fields
The system SHALL parse `token_info` as JSON and map Qoder token usage fields into the existing `AgentActivityEntry` usage fields.

#### Scenario: Token usage is normalized
- **WHEN** `token_info` contains `prompt_tokens`, `completion_tokens`, `cached_tokens`, and `max_input_tokens`
- **THEN** the emitted entry sets `usage.input_tokens` from `prompt_tokens`, `usage.output_tokens` from `completion_tokens`, `usage.cache_read_tokens` from `cached_tokens`, and `attributes.max_input_tokens` from `max_input_tokens`

#### Scenario: Total token usage is populated
- **WHEN** `prompt_tokens` and `completion_tokens` are present in `token_info`
- **THEN** the emitted entry sets `usage.total_tokens` to the sum of `prompt_tokens` and `completion_tokens`

### Requirement: Preserve Qoder identity and source metadata
The system SHALL emit Qoder SQLite token usage as Qoder agent activity while preserving minimal source identifiers for debugging.

#### Scenario: Agent type remains Qoder
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry sets `agent.type` to `qoder`

#### Scenario: Source is identified in attributes
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry sets `attributes.source` to `qoder-sqlite-chat-message`

#### Scenario: Message identifiers are retained
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry includes the SQLite `rowid` and `chat_message.id` value in `attributes`

#### Scenario: Client channel is not set
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry does not set `client.channel`

### Requirement: Use Qoder message creation time
The system SHALL use `chat_message.gmt_create` as the source event timestamp for Qoder SQLite token usage entries.

#### Scenario: Event time comes from gmt_create
- **WHEN** a Qoder SQLite token usage entry is emitted from a row with `gmt_create`
- **THEN** the entry derives `time_unix_nano` from that `gmt_create` Unix epoch millisecond value

#### Scenario: Observation time remains collector time
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry uses collector processing time for `observed_time_unix_nano`

### Requirement: Exclude non-usage Qoder message fields
The system SHALL avoid collecting Qoder chat message fields that are not required for token usage reporting.

#### Scenario: Message content fields are excluded
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry does not include `content`, `summary`, `tool_result`, or `extra` values from `chat_message`

#### Scenario: Model metadata is excluded
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry does not include `model_info` values from `chat_message`

#### Scenario: Raw token_info is not duplicated in attributes
- **WHEN** a Qoder SQLite token usage entry is emitted
- **THEN** the entry does not store the full parsed `token_info` JSON object in `attributes` (usage counts and `max_input_tokens` are mapped into standard fields only)

### Requirement: Use the existing flusher pipeline
The system SHALL route Qoder SQLite token usage entries through the existing collector input manager and flusher pipeline.

#### Scenario: JSONL output receives token entries
- **WHEN** the JSONL flusher is enabled and Qoder SQLite token usage entries are emitted
- **THEN** those entries are written by the existing JSONL flusher without a Qoder-specific output path

#### Scenario: SLS output receives token entries
- **WHEN** the SLS flusher is enabled and Qoder SQLite token usage entries are emitted
- **THEN** those entries are sent by the existing SLS flusher through the standard collector flusher pipeline

#### Scenario: JSONL and SLS receive the same entry contract
- **WHEN** both JSONL and SLS flushers are enabled
- **THEN** Qoder SQLite token usage entries are routed to both flushers using the same `AgentActivityEntry` contract
