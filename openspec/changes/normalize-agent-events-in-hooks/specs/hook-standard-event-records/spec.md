## ADDED Requirements

### Requirement: Asset hook processors emit standard-compatible records
Asset hook processors SHALL write each supported history JSONL row as a JSON object using canonical AI agent event dotted keys for stable fields that can be deterministically derived from stdin payloads or transcript rows.

#### Scenario: Cursor hook payload is normalized before history write
- **WHEN** a Cursor hook processor receives a valid hook payload with a session identifier and tool event fields
- **THEN** the history JSONL row SHALL include canonical fields such as `event.id`, `event.name`, `time_unix_nano`, `observed_time_unix_nano`, `gen_ai.agent.type`, `gen_ai.session.id`, `gen_ai.tool.name`, and `gen_ai.tool.call.id` when those source values are available

#### Scenario: Qoder transcript row is normalized before history write
- **WHEN** a Qoder hook processor forwards a supported transcript row for an assistant, user, tool call, or tool result event
- **THEN** the history JSONL row SHALL include canonical `event.name`, `gen_ai.agent.type`, `gen_ai.session.id`, model, message, tool, and status fields when those values can be derived from the row

### Requirement: Hook processors reuse asset-side normalization logic
Hook processors SHALL share common hook-side normalization behavior through dependency-free code under `assets/hooks` instead of duplicating equivalent mapping logic separately per processor.

#### Scenario: Multiple processors map common fields
- **WHEN** Cursor and Qoder processors need timestamp conversion, event ID generation, source event-name mapping, JSON sanitization, canonical record construction, raw context namespacing, user defaulting, provider fallback, content-policy filtering, or common tool/status/error mapping
- **THEN** those processors SHALL call shared asset-side normalization helpers for the common behavior

#### Scenario: Source-specific extraction is required
- **WHEN** Cursor and Qoder payload shapes require different field extraction logic
- **THEN** each processor MAY keep source-specific extraction code while delegating shared canonical mapping behavior to the asset-side helper

### Requirement: Hook records preserve replay context
Asset hook processors SHALL preserve enough source context for debugging and replay while keeping stable query fields in canonical top-level keys.

#### Scenario: Source-specific fields are namespaced
- **WHEN** a processor includes source-specific hook payload or transcript metadata in a history row
- **THEN** the processor SHALL place unmapped metadata under an `agent.<source>.*` namespace and SHALL NOT duplicate source keys that were already mapped into canonical fields

#### Scenario: Unsupported source fields remain available for fallback
- **WHEN** a processor cannot confidently map a source field to the AI agent event schema
- **THEN** the processor SHALL retain the source value in namespaced `agent.<source>.*` context instead of inventing a canonical field

### Requirement: Inputs prefer canonical hook records
Hook inputs SHALL prefer canonical dotted keys from hook history records and SHALL use legacy source-specific parsing only as fallback.

#### Scenario: Canonical hook row is collected
- **WHEN** `BaseHookInput` parses a history row that already contains `event.name` and `gen_ai.agent.type`
- **THEN** the concrete hook input SHALL build the emitted `AgentActivityEntry` primarily from those canonical fields

#### Scenario: Legacy hook row is collected
- **WHEN** `BaseHookInput` parses an existing legacy Cursor payload or Qoder transcript row without canonical event fields
- **THEN** the concrete hook input SHALL continue to emit the same semantic `AgentActivityEntry` as before the migration

### Requirement: Hook processors remain fail-open and append-only
Asset hook processors SHALL preserve the existing hook safety constraints while adding normalization.

#### Scenario: Processor receives invalid input
- **WHEN** a hook processor receives invalid JSON, an unsupported root value, a missing transcript file, or an unmappable row
- **THEN** the processor SHALL not block the source agent, SHALL preserve the expected empty hook response behavior, and SHALL write only best-effort debug or error logs

#### Scenario: Processor writes history
- **WHEN** a hook processor successfully creates one or more normalized records
- **THEN** the processor SHALL append records to the local daily history JSONL file and SHALL NOT send data directly to any flusher or remote endpoint

### Requirement: Hook processors perform best-effort local enrichment and policy
Hook processors SHALL perform best-effort local enrichment and content-policy filtering for fields that can be computed safely in the hook runtime, while the collector SHALL remain the authoritative final enforcement layer.

#### Scenario: User identity is not provided by source payload
- **WHEN** a hook payload does not provide a stable `user.id`
- **THEN** the processor SHALL apply the same documented defaulting strategy available in the hook runtime, such as environment or local OS context, and the collector SHALL still be allowed to override or validate the final value

#### Scenario: Provider is not provided by source payload
- **WHEN** a hook payload provides a model value but not `gen_ai.provider.name`
- **THEN** the processor SHALL infer provider using shared asset-side fallback rules and the collector SHALL re-apply provider fallback as the final authority

#### Scenario: Content policy applies in hook runtime
- **WHEN** a processor maps message content, tool arguments, or tool results into canonical fields
- **THEN** the processor SHALL apply hook-side content-policy filtering before writing history, and the collector SHALL re-apply content policy after reading the history record

### Requirement: Collector remains authoritative for finalization and cross-record enrichment
Hook processors SHALL NOT take ownership of transformations that require cross-record state, runtime environment enrichment outside the hook payload, or final schema cleanup.

#### Scenario: Collector-owned transformations are needed
- **WHEN** an emitted entry requires checkpoint state, final schema cleanup, git/workspace/host enrichment, trace tree construction, or cross-record correlation
- **THEN** the input and normalization layers SHALL provide those values or transformations after reading the hook history record

#### Scenario: Hook-time fields are available
- **WHEN** source payloads provide event kind, session ID, turn ID, step ID, tool name, tool call ID, explicit provider/model, token counts, cost fields, finish reasons, tool arguments, tool results, tool duration, tool status, or error fields
- **THEN** the processor SHALL map those fields to canonical dotted keys where the mapping is deterministic
