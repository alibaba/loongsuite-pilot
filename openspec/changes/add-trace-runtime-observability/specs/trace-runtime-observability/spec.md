## ADDED Requirements

### Requirement: Scalar accounting reuses the existing buffer
The system SHALL store diagnostic byte totals, missing-measurement counts and creation time on the existing OTLP turn buffer. It SHALL NOT maintain a second per-turn state map or retain extra references to event or span objects.

#### Scenario: A sized entry is appended
- **WHEN** an entry arrives with its existing serialized byte size
- **THEN** that number SHALL be added to the existing buffer without serializing or scanning event content
- **AND** record counts SHALL use the existing records array length

#### Scenario: Measurements are unavailable
- **WHEN** sizes are absent, misaligned, negative or non-finite
- **THEN** affected entries SHALL be counted as unmeasured
- **AND** normal processing SHALL continue without inventing byte sizes

### Requirement: Diagnostics do not alter processing
The system SHALL preserve main's input reads/parsing, turn grouping, buffer removal, conversion/export ordering, error handling and shutdown ordering. It SHALL NOT add source-read matching, deferred attribution, threshold triggers, detailed-record queues, per-turn memory samples or diagnostic timers.

#### Scenario: A buffer is removed before conversion finishes
- **WHEN** an existing removal path removes a buffer
- **THEN** its byte and record scalars SHALL be accounted immediately
- **AND** diagnostics SHALL NOT postpone removal or wait for an export result

### Requirement: Snapshots have limited scope and stable cumulative counters
The system SHALL report the existing pending buffers by Agent, including the largest buffer's known logical bytes, records, age and available turn/session identifiers, plus the oldest buffer age. It SHALL keep at most 64 Agent counter dimensions per flusher. Removal and converter counters SHALL be process-lifetime totals, not drained windows.

#### Scenario: Idle reporting and reactivation
- **WHEN** an Agent becomes idle and later resumes
- **THEN** removal and converter totals SHALL not reset
- **AND** the pending gauges SHALL reflect only currently existing buffers

#### Scenario: Diagnostic dimension capacity is reached
- **WHEN** more than 64 Agent names are encountered
- **THEN** diagnostics SHALL skip new dimensions without preventing their business data from being processed

#### Scenario: Pending scope is interpreted
- **WHEN** a snapshot is queried
- **THEN** `buffer_scope=pending_conversion` SHALL identify that in-flight conversion/export is excluded
- **AND** removed bytes SHALL NOT be interpreted as garbage-collected memory or freed RSS

### Requirement: Converter timing covers synchronous work only
The system SHALL count each actual synchronous converter invocation and its elapsed monotonic duration, including failures. It SHALL exclude lock waiting, asynchronous provider flushing and network export.

#### Scenario: Different service names require two conversions
- **WHEN** two distinct service names each invoke the converter
- **THEN** both calls and their own synchronous durations SHALL be accumulated exactly once
- **AND** waiting between them SHALL NOT contribute to converter duration

### Requirement: Reporting reuses the current status cycle and identity
The system SHALL emit `pilot_trace_runtime` with `schema_version=2`, `record_type=snapshot` in the existing ten-minute L1 reporting cycle, reusing that L1 record's version, run ID, instance ID, user ID and timestamp. The sender SHALL remain internal-only with no fallback to business outputs.

#### Scenario: A runtime snapshot is emitted
- **WHEN** an L1 cycle obtains snapshots
- **THEN** each row SHALL contain only approved counters, durations, buffer identifiers and process identity
- **AND** no messages, tool arguments or event bodies SHALL be included

#### Scenario: Diagnostic reporting fails
- **WHEN** snapshot collection or internal sending throws
- **THEN** existing status writes and shutdown SHALL continue

#### Scenario: A short turn completes between samples
- **WHEN** a turn appears and leaves between two reporting cycles
- **THEN** it MAY have no individual turn identifier in snapshots
- **AND** its removed-buffer totals SHALL still accumulate

### Requirement: Performance validation uses the actual pipeline
The implementation SHALL reuse precomputed event sizes and SHALL NOT add file rereads, event serialization, CPU profiling or heap snapshots for diagnostics. Before delivery it SHALL compare baseline and modified processing on the same synthetic input through InputManager, MultiFlusher and the real converter with network exports substituted.

#### Scenario: Baseline comparison is run
- **WHEN** the same workloads are processed in separate baseline and modified runs
- **THEN** business event and Trace output summaries SHALL match
- **AND** measured CPU, elapsed time and peak memory differences SHALL be reported with workload and measurement limitations
