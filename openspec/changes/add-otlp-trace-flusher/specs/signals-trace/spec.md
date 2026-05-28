## ADDED Requirements

### Requirement: Trace egress is opt-in via config

The system SHALL emit OTLP traces only when `flushers.otlpTrace.enabled === true`. When disabled or absent, no OTLP exporter, turn buffer, or trace-related file shall be created.

#### Scenario: Disabled by default
- **WHEN** `config.json` has no `flushers.otlpTrace` block
- **THEN** the system SHALL NOT register `OtlpTraceFlusher`
- **AND** existing log egress SHALL be unaffected

#### Scenario: Enabled with valid config
- **WHEN** `flushers.otlpTrace.enabled: true` with valid `endpoint`, `headers`, `serviceName`
- **THEN** the system SHALL register `OtlpTraceFlusher` into `MultiFlusher`

### Requirement: Fail-fast on incomplete config

#### Scenario: Missing endpoint
- **WHEN** `enabled: true` and `endpoint` is empty or absent
- **THEN** startup SHALL fail with a clear error

#### Scenario: Missing serviceName
- **WHEN** `enabled: true` and `serviceName` is empty
- **THEN** startup SHALL fail with a clear error

#### Scenario: Empty headers
- **WHEN** `enabled: true` and `headers` is empty
- **THEN** the system SHALL log a warning but proceed

### Requirement: Turn-based buffering with group key fallback

The system SHALL buffer entries by turn using a group key resolved via the following priority chain: `gen_ai.turn.id` > `trace_id` (valid 32-hex) > `gen_ai.session.id` > ephemeral (per-entry).

#### Scenario: Entry with turn_id
- **WHEN** an entry has `gen_ai.turn.id: "turn_abc"`
- **THEN** it SHALL be buffered under key `"turn_abc"` regardless of trace_id or session_id values

#### Scenario: Entry with trace_id only
- **WHEN** an entry has no `gen_ai.turn.id` but has valid `trace_id: "4bf92f35..."`
- **THEN** it SHALL be buffered under key derived from the trace_id

#### Scenario: Entry with session_id only
- **WHEN** an entry has no `gen_ai.turn.id` and no valid `trace_id` but has `gen_ai.session.id`
- **THEN** it SHALL be buffered under key derived from the session_id

#### Scenario: Entry with no grouping info (ephemeral)
- **WHEN** an entry has no turn_id, no valid trace_id, and no session_id
- **THEN** it SHALL be treated as a standalone micro-turn and converted immediately

### Requirement: Turn boundary detection via semantic signals

The system SHALL detect turn completion via event-driven signals, not periodic timers.

#### Scenario: Signal A — finish_reason=stop
- **WHEN** an entry has `gen_ai.response.finish_reasons` containing `"stop"`
- **THEN** the turn buffer it belongs to SHALL be marked completed immediately
- **AND** conversion + export SHALL be triggered

#### Scenario: Signal A — finish_reason=tool_calls does NOT end turn
- **WHEN** an entry has `gen_ai.response.finish_reasons` containing only `"tool_calls"`
- **THEN** the turn buffer SHALL NOT be marked completed (agent will continue)

#### Scenario: Signal B — group key change
- **WHEN** a new entry arrives for agentType X with groupKey K2, and an active buffer exists for agentType X with groupKey K1 ≠ K2
- **THEN** the K1 buffer SHALL be marked completed and flushed
- **AND** the new entry SHALL start a new buffer under K2

#### Scenario: Signal C — shutdown
- **WHEN** `shutdown()` is called with pending uncompleted turn buffers
- **THEN** all buffers SHALL be marked completed and flushed before shutdown resolves

#### Scenario: Signal D — idle timeout (optional, default disabled)
- **WHEN** `turnIdleTimeoutMs > 0` and a buffer has received no new entries for longer than that duration
- **THEN** it SHALL be marked completed and flushed
- **WHEN** `turnIdleTimeoutMs === 0` (default)
- **THEN** no idle-based flushing SHALL occur

### Requirement: Group key backfill before conversion

When the system uses `trace_id` or `session_id` as the group key (because `gen_ai.turn.id` is absent), it SHALL backfill `gen_ai.turn.id` on all entries in that buffer before passing them to the conversion library.

#### Scenario: trace_id used as group key
- **WHEN** entries are buffered under trace_id `"4bf92f35..."` and lack `gen_ai.turn.id`
- **THEN** before conversion, each entry SHALL have `gen_ai.turn.id` set to the trace_id value
- **AND** the conversion library SHALL receive entries with a populated turn_id for correct internal grouping

#### Scenario: turn_id already present
- **WHEN** entries already have `gen_ai.turn.id`
- **THEN** no backfill SHALL occur (values preserved as-is)

### Requirement: Per-turn conversion via util-genai

Each completed turn SHALL be converted independently via one `convertEventLogToTrace` call using the low-level API with a pilot-managed `BasicTracerProvider`.

#### Scenario: Normal conversion
- **WHEN** a turn buffer is marked completed with N entries
- **THEN** the system SHALL call `convertEventLogToTrace(entries, { handler, strict: false })`
- **AND** SHALL call `provider.forceFlush()` to collect finished spans
- **AND** SHALL call `inMem.reset()` after collecting spans (prevent leakage to next turn)

#### Scenario: Conversion warnings
- **WHEN** `convertEventLogToTrace` produces warnings (orphan events, invalid timestamps)
- **THEN** the system SHALL log them at warn level
- **AND** SHALL still export whatever spans were produced

#### Scenario: Empty conversion result
- **WHEN** conversion produces zero spans (e.g., all entries were unsupported event types)
- **THEN** the system SHALL skip export silently (no error, no file write)

### Requirement: Per-agent service.name derivation

#### Scenario: Known agentType
- **WHEN** `serviceName: "loongsuite-pilot"` and entry has `gen_ai.agent.type: "claude-code"`
- **THEN** Resource `service.name` SHALL be `"loongsuite-pilot-claude-code"`

#### Scenario: Missing agentType
- **WHEN** entry has no `gen_ai.agent.type`
- **THEN** suffix SHALL be `"unknown"`, producing `"<serviceName>-unknown"`

#### Scenario: agentType with mixed case/special chars
- **WHEN** entry has `gen_ai.agent.type: "Qoder CLI"`
- **THEN** normalized suffix SHALL be `"qoder-cli"`

### Requirement: Required Resource attributes

Each per-agentType provider SHALL carry a Resource with:
- `service.name` = `${serviceName}-${normalize(agentType)}`
- `service.version` = pilot package version
- `service.instance.id` = UUID v4 (stable across agentTypes within one process)
- `service.namespace` = `"loongsuite-pilot"`
- `host.name` = `os.hostname()`
- `gen_ai.agent.type` = normalized agentType
- `gen_ai.agent.system` = from AGENT_SYSTEM_MAP (unknown → `"unknown"`)
- `acs.arms.service.feature` = `"genai_app"`
- User `resourceAttributes` from config (reserved keys not overridable)

#### Scenario: Reserved attribute override attempt
- **WHEN** config has `resourceAttributes: { "service.name": "custom" }`
- **THEN** user value SHALL be dropped with a warning

#### Scenario: ARMS feature attribute always present
- **WHEN** any spans are exported
- **THEN** Resource SHALL carry `acs.arms.service.feature: "genai_app"`

#### Scenario: Stable instance ID across agents
- **WHEN** same pilot process exports for two different agentTypes
- **THEN** both Resources SHALL carry the same `service.instance.id`

### Requirement: Endpoint path normalization

#### Scenario: Without /v1/traces
- **WHEN** endpoint is `"https://example.com/apm/trace/opentelemetry"`
- **THEN** exporter URL SHALL be `"https://example.com/apm/trace/opentelemetry/v1/traces"`

#### Scenario: Already has /v1/traces
- **WHEN** endpoint is `"https://example.com/v1/traces"`
- **THEN** URL SHALL be used as-is

#### Scenario: Trailing slash
- **WHEN** endpoint is `"https://example.com/otlp/"`
- **THEN** trailing slash SHALL be stripped before appending `/v1/traces`

### Requirement: captureMessageContent config

#### Scenario: Enabled (default)
- **WHEN** `captureMessageContent` is `true` or omitted
- **THEN** pilot SHALL set `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` if not already set
- **AND** spans SHALL contain `gen_ai.input.messages` / `gen_ai.output.messages` content

#### Scenario: Disabled
- **WHEN** `captureMessageContent` is `false`
- **THEN** pilot SHALL NOT set those env vars
- **AND** spans SHALL still have full structure (token counts, model, finish_reason) but no message text

### Requirement: Debug double-write

#### Scenario: Debug enabled
- **WHEN** `debug: true` and spans are about to be exported
- **THEN** OTLP/JSON serialized form SHALL be appended to `~/.loongsuite-pilot/logs/otlp-debug/<service-name>-YYYY-MM-DD.jsonl`
- **AND** export SHALL proceed regardless of debug-write outcome

#### Scenario: Debug write failure
- **WHEN** debug file cannot be written
- **THEN** warning SHALL be logged; export SHALL still proceed

#### Scenario: Debug disabled (default)
- **WHEN** `debug` is `false` or omitted
- **THEN** no files SHALL be created under `otlp-debug/`

### Requirement: Failed-batch persistence

#### Scenario: Permanent export failure
- **WHEN** OTLPExporter callback reports FAILED
- **THEN** spans SHALL be persisted to `~/.loongsuite-pilot/logs/otlp-failed/<service-name>.jsonl` with `_error` field

#### Scenario: Transient failure recovered by SDK retry
- **WHEN** SDK internal retry succeeds
- **THEN** nothing SHALL be written to failed-log

#### Scenario: Both debug and failure
- **WHEN** `debug: true` and export fails permanently
- **THEN** batch SHALL appear in BOTH `otlp-debug/` and `otlp-failed/`

### Requirement: Graceful shutdown

#### Scenario: Shutdown with pending buffers
- **WHEN** shutdown is called with uncompleted turn buffers
- **THEN** all SHALL be force-completed, converted, and exported before resolving

#### Scenario: Shutdown awaits in-flight exports
- **WHEN** exports are in-flight at shutdown time
- **THEN** shutdown SHALL await their callbacks before calling `exporter.shutdown()`

### Requirement: Provider never registered globally

The `BasicTracerProvider` instances created by the flusher SHALL NEVER call `register()`. They exist as local instances only.

#### Scenario: Global tracer unaffected
- **WHEN** OtlpTraceFlusher is running
- **THEN** `trace.getTracerProvider()` from `@opentelemetry/api` SHALL NOT return pilot's provider
