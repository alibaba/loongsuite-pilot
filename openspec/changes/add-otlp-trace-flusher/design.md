## Context

`MultiFlusher` already supports parallel fan-out across `BaseFlusher` implementations. CMS 2.0 (ARMS GenAI) provides an OTLP/HTTP endpoint that requires real `ResourceSpans` payloads.

A new shared library `@loongsuite/opentelemetry-util-genai` provides `convertEventLogToTrace(records, { handler })` which accepts flat event log records and drives an `ExtendedTelemetryHandler` to produce ENTRY/AGENT/STEP/LLM/TOOL span trees. The library's `PILOT_INTEGRATION.md` recommends:
- Use the low-level API (`convertEventLogToTrace` + self-managed `BasicTracerProvider`) for production
- Buffer entries per turn; convert per-turn (not per-entry)
- Inject pilot's Resource via the provider (not post-hoc)
- Never call `provider.register()` (avoid global OTel context pollution)

## Goals / Non-Goals

**Goals:**
- Complete end-to-end OTLP trace pipeline: entry → turn buffer → boundary detect → convert → export.
- Multi-tenant by agent: single `serviceName` config, runtime suffix per agentType.
- Correct turn splitting across all current plugins (Claude Code via trace_id, Cursor via turn_id, Qoder Work via session_id + finish_reason).
- Debug double-write and failure persistence.

**Non-Goals:**
- No env-var configuration (`OTEL_EXPORTER_OTLP_*` envs not honored).
- No `TracerProvider.register()`.
- No OTLP/gRPC or OTLP/HTTP-JSON (only `http/protobuf`).
- No auto-replay of failed batches.
- No OTel signal types other than trace.

## Decisions

### D1. Turn-based buffering model (replaces per-entry conversion)

The flusher buffers entries by turn and converts per-completed-turn. The minimum atomic unit for conversion is **one turn's complete set of entries** because:
- ENTRY/AGENT spans require token aggregation across all events in the turn
- `messages_delta` accumulates across steps within a turn
- LLM request/response pairing requires both sides present

Each `TurnBuffer` has a `completed` flag. Only completed turns are passed to conversion.

### D2. Group key fallback chain

Determines which entries belong to the same turn:

```
Priority:
  1. gen_ai.turn.id    (Cursor: ✓ present)
  2. trace_id          (Claude Code: one per turn, validated 32-hex)
  3. gen_ai.session.id (Qoder Work: fallback, coarser grain)
  4. ephemeral         (no grouping info → each entry is its own micro-turn)
```

Implementation: `resolveGroupKey(entry)` returns the first non-empty value.

### D3. Turn-end boundary detection (event-driven, not timer-based)

| Signal | Condition | Action |
|--------|-----------|--------|
| A. finish_reason=stop | `entry['gen_ai.response.finish_reasons']` includes `'stop'` | Mark current turn `completed`, trigger flush |
| B. Group key change | New entry's groupKey ≠ any active buffer's key (for same agentType) | Mark the OLD buffer `completed`, trigger flush |
| C. shutdown() | Process exit | Mark ALL buffers `completed`, flush all |
| D. Idle timeout (optional) | `turnIdleTimeoutMs > 0` and `now - lastActivity > timeout` | Mark `completed`, trigger flush |

Default `turnIdleTimeoutMs = 0` (disabled). Signal A and B cover normal cases; Signal C covers process lifecycle; Signal D is a user-opt-in safety net.

**Signal B detail**: When a new entry arrives for agentType X with groupKey K2, and there's an active buffer for agentType X with groupKey K1 ≠ K2, then K1's buffer is completed. This works because entries from the same JSONL file are sequential — when a new turn starts writing, the old turn must have finished writing.

### D4. Group key backfill before conversion

When pilot uses `trace_id` as the group key (because `gen_ai.turn.id` is absent), it MUST backfill `gen_ai.turn.id` on all entries before passing to util-genai. Otherwise util-genai's internal `groupByTurn()` would merge records from different turns into one `__no_turn__` group.

```ts
if (!entry['gen_ai.turn.id'] && groupKeySource === 'trace_id') {
  entry['gen_ai.turn.id'] = groupKeyValue; // backfill
}
```

### D5. Per-turn conversion (no cross-turn merging)

Each completed turn is converted independently via one `convertEventLogToTrace` call. Merging multiple turns into one call is unsafe when entries lack `gen_ai.turn.id` (util-genai cannot distinguish them internally). Per-turn conversion is simple, correct, and has negligible performance overhead since the `BasicTracerProvider` is reused.

### D6. Low-level util-genai API with pilot-owned provider

Per `PILOT_INTEGRATION.md` §5.2, production code uses:

```ts
// Per-agentType, reused across turns:
interface AgentConvertState {
  provider: BasicTracerProvider;  // carries pilot's Resource
  handler: ExtendedTelemetryHandler;
  inMem: InMemorySpanExporter;
}

// Convert one turn:
convertEventLogToTrace(records as EventLogRecord[], { handler });
await provider.forceFlush();
const spans = inMem.getFinishedSpans();
inMem.reset();  // clear buffer for next turn
```

The provider is **never** `register()`'d. It lives as a local instance per agentType.

### D7. Single `serviceName` config; runtime suffix per agentType

`service.name = ${serviceName}-${normalize(agentType)}`. Edge cases:
- Missing agentType → suffix = `unknown`
- Empty `serviceName` with `enabled: true` → fail-fast at startup

### D8. agentType normalization to lower-kebab

`normalizeAgentType(raw)`: lowercase → non-alphanumeric runs → single `-` → trim → empty becomes `unknown`.

### D9. `gen_ai.agent.system` from explicit AGENT_SYSTEM_MAP

```ts
export const AGENT_SYSTEM_MAP: Record<string, string> = {
  'claude-code':    'claude',
  'codex':          'codex',
  'codex-session':  'codex',
  'qoder':          'qoder',
  'qoder-idea':     'qoder',
  'qoder-work':     'qoder',
  'qoder-cli':      'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor':         'cursor',
  'cursor-hook':    'cursor',
};
```

New agent onboarding requires adding an entry here.

### D10. Required Resource attributes

Each per-agentType `BasicTracerProvider` carries a `Resource` with:

| Attribute | Source |
|---|---|
| `service.name` | `${serviceName}-${normalize(agentType)}` |
| `service.version` | pilot package version |
| `service.instance.id` | UUID v4 (once per flusher startup) |
| `service.namespace` | `"loongsuite-pilot"` |
| `host.name` | `os.hostname()` |
| `gen_ai.agent.type` | normalized agentType |
| `gen_ai.agent.system` | `resolveAgentSystem(agentType)` |
| `acs.arms.service.feature` | `"genai_app"` |
| user `resourceAttributes` | from config (reserved keys not overridable) |

### D11. Per-agent OTLPTraceExporter

Each agentType also gets one `OTLPTraceExporter` instance (for network). On flush, `inMem.getFinishedSpans()` → `exporter.export(spans, cb)`.

### D12. Endpoint path normalization

Append `/v1/traces` if not already present. Strip trailing slash first.

### D13. captureMessageContent config

When `flushers.otlpTrace.captureMessageContent === true` (default), pilot sets at process startup:

```ts
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= "gen_ai_latest_experimental";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= "SPAN_ONLY";
```

When false, these env vars are not set → spans still have full structure but no message text content.

### D14. Debug double-write

When `debug === true`: before `exporter.export()`, serialize the spans to OTLP/JSON and append to `~/.loongsuite-pilot/logs/otlp-debug/<service-name>-YYYY-MM-DD.jsonl`. Debug write failure does not block export.

### D15. Failure persistence

When `exporter.export()` callback reports `ExportResultCode.FAILED`: append to `~/.loongsuite-pilot/logs/otlp-failed/<service-name>.jsonl` with `_error` field. No auto-replay.

### D16. Flush is event-driven, not timer-based

No `flushIntervalMs` for the trace flusher. Conversion + export happens immediately when a turn is marked completed. This provides lowest latency: spans appear in ARMS as soon as a turn ends.

### D17. Test seam

`exportSpansForAgent(agentType, spans[])` — package-private method that bypasses turn buffering and conversion, pushing spans directly to the export path. Used by unit tests to verify transport/debug/failure independently.

## Open Questions

None.

## Out of Scope

- OTLP/HTTP-JSON or OTLP/gRPC protocol support.
- Auto-replay of failed batches.
- OTel metric or log signal export.
- Env-var based configuration.
