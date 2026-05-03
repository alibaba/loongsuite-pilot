## ADDED Requirements

### Requirement: Baseline existing SQLite token rows on first start
The system SHALL NOT emit historical Qoder SQLite token usage rows when the `qoder-sqlite` input starts without a persisted rowid cursor.

#### Scenario: Fresh state skips historical eligible rows
- **WHEN** the Qoder SQLite database already contains eligible `chat_message` token rows and `qoder-sqlite` has no persisted `lastRowId`
- **THEN** startup records the current maximum eligible rowid and emits no entries for those existing rows

#### Scenario: Fresh state with empty database remains safe
- **WHEN** the Qoder SQLite database contains no eligible token rows and `qoder-sqlite` has no persisted `lastRowId`
- **THEN** startup emits no entries and remains ready to collect future eligible rows

### Requirement: Collect rows inserted after startup baseline
The system SHALL emit eligible Qoder SQLite token usage rows inserted after the startup baseline.

#### Scenario: New row after baseline is emitted
- **WHEN** `qoder-sqlite` starts with no persisted cursor, baselines existing rows, and a new eligible token row is inserted after startup
- **THEN** the next collection emits the new row and advances the rowid cursor

### Requirement: Preserve existing cursor behavior
The system SHALL NOT overwrite an existing `qoder-sqlite` rowid cursor during startup.

#### Scenario: Existing state resumes incrementally
- **WHEN** `qoder-sqlite` starts with a persisted `lastRowId`
- **THEN** startup preserves that cursor and normal polling emits eligible rows with `rowid > lastRowId`

#### Scenario: Rows that arrived while stopped are still collected
- **WHEN** `qoder-sqlite` has a persisted cursor and eligible rows were inserted after that cursor while the collector was stopped
- **THEN** startup does not baseline past those rows and polling emits them

### Requirement: Baseline only token-eligible rows
The system SHALL compute the startup baseline using the same token eligibility filters used for normal collection.

#### Scenario: Invalid token rows do not define token baseline
- **WHEN** historical rows contain empty, null, or invalid `token_info`
- **THEN** the startup baseline is based on the maximum rowid among rows with non-empty valid JSON `token_info`
