## ADDED Requirements

### Requirement: Exact Append-Only Output Totals
The system SHALL compute dashboard `Events Today` and `Tokens Today` from all valid records in fully indexed matching daily output JSONL files for normal append-only files, regardless of file size.

#### Scenario: Large append-only file remains exact
- **WHEN** a daily output JSONL file grows beyond the dashboard's bounded read size and the file is fully indexed
- **THEN** the overview totals SHALL include records from the full file, not only the tail window

#### Scenario: Token total does not decrease during append-only growth
- **WHEN** new valid records are appended to a fully indexed daily output JSONL file
- **THEN** `Tokens Today` SHALL be greater than or equal to the previous value for the same local date unless appended records contain negative token values

### Requirement: Bounded Cold-Cache Indexing
The system SHALL limit the amount of output JSONL content processed during one overview refresh when a file has no valid cache entry or must be rebuilt.

#### Scenario: Existing large file after upgrade
- **WHEN** a user opens the dashboard after upgrading and a matching daily output JSONL file is larger than the per-refresh indexing budget
- **THEN** the overview aggregator SHALL process no more than the internal byte or line budget for that file during the refresh

#### Scenario: Later refresh continues indexing
- **WHEN** a previous refresh stopped before fully indexing a matching daily output JSONL file
- **THEN** the next overview refresh SHALL continue processing from the saved offset

#### Scenario: Totals marked partial during indexing
- **WHEN** any matching daily output JSONL file is not fully indexed
- **THEN** the overview response SHALL expose additive metadata indicating that output totals are partial or indexing is in progress

### Requirement: Incremental Overview Refresh
The system SHALL avoid rescanning unchanged output bytes after it has already summarized a file.

#### Scenario: Refresh after append reads only new content
- **WHEN** the dashboard refreshes after a previously summarized output file receives new appended lines
- **THEN** the overview aggregator SHALL process only the newly appended bytes for that file

#### Scenario: Refresh with unchanged files reuses cached summary
- **WHEN** the dashboard refreshes and a summarized output file has not changed
- **THEN** the overview aggregator SHALL reuse the cached summary for that file

### Requirement: Safe Cache Rebuild
The system SHALL detect cache states that cannot be trusted and rebuild the affected file summary from source JSONL.

#### Scenario: File shrinks
- **WHEN** an output file size is smaller than the cached processed offset
- **THEN** the overview aggregator SHALL discard the cached summary for that file and rebuild from the beginning

#### Scenario: Cache is invalid
- **WHEN** a persisted overview cache entry is missing required fields or uses an unsupported version
- **THEN** the overview aggregator SHALL ignore that entry and rebuild the affected summary from source JSONL

### Requirement: Persistent Derived Cache
The system SHALL persist derived overview aggregation metadata under the LoongSuite Pilot data directory and treat it as disposable cache data.

#### Scenario: Dashboard process restarts
- **WHEN** the dashboard server restarts and a valid overview cache exists
- **THEN** the overview aggregator SHALL resume from cached processed offsets, including incomplete indexing offsets, instead of falling back to tail-only approximation

#### Scenario: Cache is deleted
- **WHEN** the persisted overview cache is deleted
- **THEN** the dashboard SHALL rebuild summaries from source output JSONL files in bounded indexing batches without requiring user action

### Requirement: Sensitive Content Exclusion
The system SHALL NOT store raw prompt, output, tool result, transcript, or message body fields in overview cache data.

#### Scenario: Cache persists derived data only
- **WHEN** the overview aggregator writes its cache
- **THEN** the cache SHALL contain only derived counts, token sums, timestamps, event names, agent or method identifiers, and file metadata
