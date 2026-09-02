## ADDED Requirements

### Requirement: Trace runtime records use a separate internal topic

The system SHALL send Trace runtime diagnostics to the internal `pilot_trace_runtime` topic and SHALL NOT add these fields to `AgentActivityEntry`, OTLP spans, or user-configured output destinations.

#### Scenario: Runtime record is emitted
- **WHEN** a Trace runtime window or turn detail is ready
- **THEN** the record SHALL be sent with `__topic__=pilot_trace_runtime` and `schema_version=1`
- **AND** it SHALL NOT pass through the normal `MultiFlusher` data fan-out

#### Scenario: Open-source sender is inactive
- **WHEN** the build uses the no-op internal status sender
- **THEN** normal event collection and Trace export SHALL continue unchanged
- **AND** no user output SHALL receive the runtime record as a fallback

### Requirement: Every runtime record carries correlatable identity

Every `pilot_trace_runtime` record SHALL carry `version`, `run_id`, `instance_id`, `user_id`, `agent_type`, `input_name`, `record_type`, and `__time__`. The `run_id` and `instance_id` SHALL equal the values emitted by `pilot_status` for the same process.

#### Scenario: Correlate a runtime record with a process alarm
- **WHEN** a runtime record and a `pilot_status` record come from the same Pilot process
- **THEN** their `run_id`, `instance_id`, `user_id`, and `version` SHALL match

#### Scenario: Process restarts
- **WHEN** the same installation starts a new Pilot process
- **THEN** `instance_id` SHALL remain stable
- **AND** `run_id` SHALL change

### Requirement: Batch context preserves input identity and precomputed event sizes

The system SHALL pass an optional internal batch context from `InputManager` through `MultiFlusher` containing `input_name` and an event logical byte value aligned with each dispatched entry. Existing flushers SHALL be allowed to ignore this context.

#### Scenario: Normal batch dispatch
- **WHEN** `InputManager` serializes N expanded and masked events to calculate output bytes
- **THEN** it SHALL retain the N per-event UTF-8 byte lengths and pass them with the same entries in the same order
- **AND** it SHALL NOT serialize those events a second time for Trace runtime accounting

#### Scenario: Invalid byte alignment
- **WHEN** the number of byte values does not equal the number of dispatched entries
- **THEN** Trace runtime accounting SHALL skip logical-byte attribution for that batch and log a warning
- **AND** every normal flusher SHALL still receive and process the entries

### Requirement: Source reads are measured without inventing turn attribution

An input source SHALL be able to attach source-byte measurements using actual `bytesRead` or consumed offset deltas together with available Agent, session, turn, and trace identifiers. The system MUST NOT substitute produced event size for source bytes.

#### Scenario: Exact Codex turn range is read
- **WHEN** `codex-transcript` reads a byte range that is associated with one turn
- **THEN** those bytes SHALL contribute to that turn's `source_bytes_total`
- **AND** `source_bytes_basis` SHALL describe whether the value came from `bytes_read` or `offset_delta`

#### Scenario: Qoder tail lines are consumed
- **WHEN** `qoder-trace` consumes new source lines and can associate their byte lengths with turn identifiers
- **THEN** it SHALL aggregate those consumed bytes into the matching turn without rereading the file

#### Scenario: Source bytes cannot be assigned reliably
- **WHEN** a source read spans data that cannot be mapped to a specific turn
- **THEN** the bytes SHALL contribute to both `source_bytes_total` and its subset `source_bytes_unattributed` in the matching window
- **AND** a turn detail SHALL omit `source_bytes_total` and `source_bytes_basis` rather than report an estimate as exact

### Requirement: Turn buffer watermarks use incremental accounting

For each active OTLP turn buffer, the system SHALL maintain current and peak record counts, current and peak logical bytes, produced event bytes, source bytes, first activity time, last activity time, and triggered-threshold state using incremental updates. It MUST NOT traverse or reserialize the buffered records to calculate these values.

#### Scenario: Entry is appended to a turn
- **WHEN** an entry with logical size B is appended
- **THEN** the turn's current record count SHALL increase by one
- **AND** its current and produced logical byte counts SHALL increase by B
- **AND** peak values SHALL be updated using the new current values

#### Scenario: Turn is released
- **WHEN** a turn buffer leaves its active lifecycle
- **THEN** `released_logical_bytes` SHALL equal the logical bytes removed from that lifecycle
- **AND** current aggregate gauges SHALL decrease without scanning the released records

### Requirement: Window records summarize normal and abnormal turns

The system SHALL emit one `record_type=window` record every ten minutes for each `agent_type + input_name` dimension with activity or an active turn. A partial window containing activity or active turns SHALL be emitted during graceful shutdown.

#### Scenario: Ten-minute window is emitted
- **WHEN** the reporting interval ends for an Agent/input dimension
- **THEN** the window SHALL include `window_ms`, `source_bytes_total`, `source_bytes_unattributed`, `produced_event_count_total`, and `produced_event_bytes_total`
- **AND** it SHALL include `active_turn_count`, `buffer_records_current`, and `buffer_logical_bytes_current`
- **AND** it SHALL identify the largest active turn through `largest_active_session_id`, `largest_active_turn_id`, and `largest_active_trace_id` when available and report `largest_active_turn_logical_bytes`
- **AND** it SHALL report `oldest_active_turn_lifetime_ms`

#### Scenario: Completed-turn distribution is emitted
- **WHEN** one or more turns complete during a window
- **THEN** the record SHALL include `completed_turn_count`, `released_logical_bytes_total`, and `completed_turn_logical_bytes_max`
- **AND** it SHALL include `completed_turn_le_1m_count`, `completed_turn_1m_to_16m_count`, `completed_turn_16m_to_64m_count`, `completed_turn_64m_to_256m_count`, `completed_turn_256m_to_1g_count`, and `completed_turn_gt_1g_count`
- **AND** it SHALL include `converted_span_count_total`, `convert_attempt_count`, `convert_duration_ms_total`, `convert_duration_ms_max`, `convert_failed_count`, `export_turn_count`, `export_duration_ms_total`, `export_duration_ms_max`, and `export_failed_turn_count`
- **AND** `export_turn_count` SHALL count each turn once regardless of how many export destinations are configured

#### Scenario: Only small normal turns complete
- **WHEN** all completed turns remain below every detail threshold and succeed normally
- **THEN** their counts, bytes, distribution, and stage durations SHALL appear in the window
- **AND** no per-turn detail SHALL be required

#### Scenario: Window counters are drained
- **WHEN** a window record is generated
- **THEN** flow and completed-turn counters SHALL restart for the next window
- **AND** active-turn counts, current buffered bytes, and largest/oldest active-turn fields SHALL remain current gauges

### Requirement: Large-turn thresholds produce deduplicated details

The system SHALL emit `record_type=turn,event=threshold_crossed` when a turn first crosses each logical-buffer threshold of 64 MiB, 256 MiB, and 1 GiB or each lifetime threshold of 30 minutes and 2 hours. These thresholds SHALL control detail volume only and MUST NOT trigger an alarm or release.

#### Scenario: One append crosses multiple size tiers
- **WHEN** a turn grows from below 64 MiB to above 1 GiB in one append
- **THEN** one detail SHALL be queued for each newly crossed size tier
- **AND** no detail for any of those tiers SHALL be queued again for that turn

#### Scenario: Lifetime threshold passes while no event arrives
- **WHEN** an open turn remains inactive long enough to cross a lifetime threshold
- **THEN** the periodic runtime check SHALL detect the crossing by inspecting lightweight turn metadata
- **AND** it SHALL NOT inspect the buffered event array

#### Scenario: Threshold detail content
- **WHEN** a threshold detail is created
- **THEN** it SHALL contain available `session_id`, `turn_id`, and `trace_id` plus `threshold_kind`, `threshold_value`, `lifetime_ms`, `produced_event_bytes_total`, `buffer_records_current`, `buffer_logical_bytes_current`, `peak_buffer_records`, `peak_buffer_logical_bytes`, `rss_bytes`, and `heap_used_bytes`
- **AND** it SHALL contain `source_bytes_total` and `source_bytes_basis` only when source attribution is reliable

### Requirement: Important releases produce final turn details

The system SHALL emit `record_type=turn,event=released` for a turn that crossed any detail threshold or that ended through forced release, idle timeout, incomplete process shutdown, an existing protection limit, conversion failure, or export failure. A small turn that ends normally and successfully SHALL be represented only by its window aggregate.

#### Scenario: Large turn completes successfully
- **WHEN** a turn crossed any size or lifetime threshold and later completes normally
- **THEN** exactly one final released detail SHALL report its complete lifecycle and `result=success`

#### Scenario: Small turn fails conversion
- **WHEN** a below-threshold turn fails Trace conversion
- **THEN** a final released detail SHALL be emitted with `result=convert_failed`

#### Scenario: One export destination fails
- **WHEN** conversion succeeds but any configured export destination fails for the turn
- **THEN** a final released detail SHALL be emitted with `result=export_failed`

#### Scenario: Small turn completes normally
- **WHEN** a turn crosses no threshold, uses a normal terminal boundary, and conversion and export succeed
- **THEN** no turn detail SHALL be emitted
- **AND** its completed statistics SHALL remain present in the window

#### Scenario: Release detail content
- **WHEN** a final released detail is emitted
- **THEN** it SHALL contain available `session_id`, `turn_id`, and `trace_id` plus `release_reason`, `boundary_signal`, `lifetime_ms`, `produced_event_bytes_total`, `peak_buffer_records`, `peak_buffer_logical_bytes`, `released_logical_bytes`, and `result`
- **AND** it SHALL contain `source_bytes_total` and `source_bytes_basis` only when source attribution is reliable
- **AND** it SHALL contain `converted_span_count`, `convert_duration_ms`, `export_duration_ms`, `rss_before_convert_bytes`, `rss_after_convert_bytes`, `heap_used_before_convert_bytes`, and `heap_used_after_convert_bytes` only for stages and samples that occurred

#### Scenario: Release reason is encoded
- **WHEN** a final release detail is built
- **THEN** `release_reason` SHALL be one of `terminal`, `group_successor`, `idle_timeout`, `buffer_limit`, `shutdown_incomplete`, or `forced`
- **AND** `boundary_signal` SHALL be a stable machine-queryable code rather than a free-text error message

### Requirement: Stage measurements have defined boundaries

The system SHALL measure lifetime, conversion duration, and export duration using a monotonic clock. It SHALL sample process memory immediately before conversion and immediately after conversion has produced spans and cleared conversion-temporary state.

#### Scenario: Conversion and parallel export succeed
- **WHEN** a turn is converted and exported to one or more destinations
- **THEN** `convert_duration_ms` SHALL cover only conversion work
- **AND** `export_duration_ms` SHALL be wall-clock time from export fan-out start until all destinations settle, rather than the sum of parallel durations
- **AND** `converted_span_count` SHALL count spans produced once, not once per destination

#### Scenario: Conversion throws
- **WHEN** conversion fails after its before-memory sample
- **THEN** the final detail SHALL retain the before sample and capture an after-failure sample when possible
- **AND** unavailable later-stage fields SHALL be omitted rather than fabricated as zero

### Requirement: Runtime fields preserve their measurement semantics

The system SHALL treat logical byte fields as serialized processing volume and whole-process RSS/heap fields as correlation signals. It MUST NOT report either as memory exclusively owned by a turn.

#### Scenario: Logical bytes and RSS rise together
- **WHEN** a turn's `peak_buffer_logical_bytes` and process RSS both rise
- **THEN** the records SHALL provide both measurements without claiming a fixed conversion ratio or exclusive ownership

#### Scenario: Source data is reread
- **WHEN** an input reads the same source range again as part of real processing
- **THEN** actual read bytes SHALL be counted again in `source_bytes_total`
- **AND** unique file growth SHALL NOT be substituted for actual work unless the field basis is explicitly `offset_delta`

### Requirement: The schema is reusable across buffered Trace agents

The runtime observer SHALL derive `agent_type` from the buffered events and `input_name` from the batch context, allowing all Agents using the common OTLP turn buffer to use the same record structure.

#### Scenario: Codex transcript turn
- **WHEN** a Codex turn from `codex-transcript` is observed
- **THEN** records SHALL use `agent_type=codex` and `input_name=codex-transcript`

#### Scenario: Qoder trace turn
- **WHEN** a Qoder turn from `qoder-trace` is observed
- **THEN** records SHALL use `agent_type=qoder` and `input_name=qoder-trace`

#### Scenario: Another buffered Agent is added
- **WHEN** another Agent already uses the common OTLP turn buffer and receives valid batch context
- **THEN** buffer, conversion, export, and release diagnostics SHALL work without an Agent-specific runtime schema
- **AND** only source-byte attribution MAY require an input-specific lightweight measurement

### Requirement: Runtime diagnostics remain bounded and fail open

The system SHALL keep at most 1024 pending turn-detail records, flush them at least every 30 seconds and during graceful shutdown, and isolate all diagnostic failures from normal collection and Trace export.

#### Scenario: Detail queue reaches capacity
- **WHEN** a new detail arrives while 1024 details are pending
- **THEN** the oldest pending detail SHALL be dropped
- **AND** `detail_dropped_count` SHALL increase and appear in the next window record

#### Scenario: Internal status send fails
- **WHEN** a `pilot_trace_runtime` send or serialization fails
- **THEN** the failure SHALL be logged without rejecting the input batch, conversion, or normal export operation

#### Scenario: Hot-path overhead is evaluated
- **WHEN** events are appended and released under normal load
- **THEN** runtime accounting SHALL use integer updates, aligned precomputed byte values, and monotonic timestamp reads only
- **AND** it MUST NOT reread transcripts, traverse or reserialize a turn buffer, create a heap snapshot, or enable CPU profiling

### Requirement: Runtime diagnostics contain identifiers but no user content

The system SHALL allow raw `user_id`, `session_id`, `turn_id`, and `trace_id` values for incident correlation, but MUST NOT include user prompts, model responses, tool input/output, file contents, or event payload bodies in `pilot_trace_runtime`.

#### Scenario: Turn detail is serialized
- **WHEN** a turn threshold or release record is built
- **THEN** only schema-approved identifiers, counters, durations, result fields, and process samples SHALL be serialized
- **AND** no value SHALL be copied from message-content or tool-content fields

### Requirement: Observability does not change turn processing behavior

Adding Trace runtime diagnostics SHALL NOT change how a turn is grouped, completed, force-released, converted, exported, or retried.

#### Scenario: Runtime observer is absent or fails
- **WHEN** no observer is injected or an observer callback throws
- **THEN** `OtlpTraceFlusher` SHALL preserve its pre-change turn and export behavior

#### Scenario: Threshold is crossed
- **WHEN** a turn crosses a reporting threshold
- **THEN** the system SHALL record diagnostics only
- **AND** it SHALL NOT release the turn or emit a new process alarm because of that threshold
