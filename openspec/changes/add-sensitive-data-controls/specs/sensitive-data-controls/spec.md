## ADDED Requirements

### Requirement: Per-Agent Sensitive Data Config
The system SHALL load a top-level `contentData` object from the user config file and interpret each direct child key as an `agent.type` policy.

#### Scenario: Defaults when config is missing
- **WHEN** the config file does not contain `contentData`
- **THEN** the collector SHALL upload sensitive content fields.

#### Scenario: Defaults for omitted policy fields
- **WHEN** an agent policy omits `uploadEnabled`
- **THEN** the collector SHALL default `uploadEnabled` to true for that agent.

#### Scenario: String boolean config values
- **WHEN** an agent policy contains string boolean values such as `"true"` or `"false"` for `uploadEnabled`
- **THEN** the collector SHALL parse them as boolean values.

#### Scenario: Agent type policy lookup
- **WHEN** multiple inputs produce entries with the same `agent.type`
- **THEN** the collector SHALL apply the same `contentData.<agent.type>` policy to all of those entries.

### Requirement: Sensitive Content Upload Control
The system SHALL treat message and tool-call content fields as sensitive content and SHALL delete those fields before dispatch when upload is disabled for the entry's `agent.type`.

#### Scenario: Upload disabled for agent
- **WHEN** `contentData.cursor.uploadEnabled` is false and a Cursor entry contains `input.messages`
- **THEN** the collector SHALL delete `input.messages` before the entry is dispatched to any flusher.

#### Scenario: Non-sensitive metadata remains
- **WHEN** sensitive content fields are deleted because upload is disabled
- **THEN** the collector SHALL retain non-sensitive fields such as event name, agent type, session id, model, usage, cost, and timestamps.

#### Scenario: Upload enabled for agent
- **WHEN** `contentData.cursor.uploadEnabled` is true
- **THEN** the collector SHALL preserve sensitive content fields for Cursor entries.

### Requirement: Flusher-Independent Policy Application
The system SHALL apply sensitive data policy before entries are sent to configured flushers so JSONL, SLS, and HTTP outputs observe the same policy-applied entry.

#### Scenario: Multiple flushers enabled
- **WHEN** JSONL, SLS, and HTTP flushers are enabled
- **THEN** each flusher SHALL receive entries after the same sensitive content upload policy has been applied.

#### Scenario: Policy application failure
- **WHEN** sensitive data policy application encounters malformed config or unexpected entry shape
- **THEN** the collector SHALL continue processing without crashing and SHALL use fail-open defaults for the affected policy decision.
