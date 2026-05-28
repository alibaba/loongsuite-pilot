## Why

Today, pilot's data egress is **log-only**: every `AgentActivityEntry` is serialized as a flat KV record and shipped to SLS / JSONL / HTTP via `MultiFlusher`. Although each entry carries OTel-style `trace_id` / `span_id` / `parent_span_id` fields, they ride on log records — they do not produce real OTLP spans that downstream telemetry backends can render as call-tree visualizations.

ARMS / CMS 2.0 has a dedicated GenAI Trace UI that requires real OTLP spans to render call-tree, latency waterfall, and per-step token attribution. Today, pilot users running multiple AI coding agents see only a flat event log in SLS; they cannot see the tree structure of a single Turn or compare latency across LLM/tool steps.

A new shared library `@loongsuite/opentelemetry-util-genai` now provides a complete event-log → OTel-span conversion engine. It accepts flat `EventLogRecord[]` (field-compatible with `AgentActivityEntry`) and produces a full `ReadableSpan[]` tree (ENTRY/AGENT/STEP/LLM/TOOL) ready for OTLP export. Pilot only needs to:
1. Buffer entries by turn
2. Detect turn boundaries
3. Call `convertEventLogToTrace` with a pilot-owned `BasicTracerProvider` (injecting pilot's Resource)
4. Export the resulting spans via `OTLPTraceExporter`

This change builds the **complete end-to-end OTLP trace pipeline** — from entry ingestion through turn buffering, boundary detection, conversion via util-genai, per-agent OTLP export, debug double-write, and failure persistence.

## What Changes

- **New flusher type** `OtlpTraceFlusher` (sibling to `SlsFlusher` / `JsonlFlusher` / `HttpFlusher`) registered into the existing `MultiFlusher` fan-out.
- **Turn-based buffering model**: entries are buffered by turn (grouped via `gen_ai.turn.id` > `trace_id` > `gen_ai.session.id` fallback chain). Turn boundaries are detected via finish_reason=stop and group-key changes — not timers.
- **Integration with `@loongsuite/opentelemetry-util-genai`**: uses the low-level `convertEventLogToTrace` + `ExtendedTelemetryHandler` API with a pilot-managed `BasicTracerProvider` per agentType (never `register()`'d globally). This injects pilot's Resource attributes directly into spans.
- **New config block** `flushers.otlpTrace` in `~/.loongsuite-pilot/config.json`. Structured fields only — no environment-variable fallback.
- **Single `serviceName` config field**, runtime suffix per agent: `service.name = ${serviceName}-${normalize(agentType)}`.
- **Per-agent routing**: lazily creates one `BasicTracerProvider` + `ExtendedTelemetryHandler` + `InMemorySpanExporter` (for conversion) and one `OTLPTraceExporter` (for network) per encountered agentType.
- **Required Resource attributes** include `acs.arms.service.feature: "genai_app"` and `gen_ai.agent.system` resolved via an explicit `AGENT_SYSTEM_MAP`.
- **captureMessageContent config**: controls whether pilot sets `OTEL_SEMCONV_STABILITY_OPT_IN` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env vars (default true = full prompt/response content in spans).
- **Debug double-write**: when `debug = true`, every batch is also written to `~/.loongsuite-pilot/logs/otlp-debug/` in OTLP/JSON format.
- **Failure persistence**: when export fails permanently, batches are persisted to `~/.loongsuite-pilot/logs/otlp-failed/`.
- **New OpenSpec capability `signals-trace`** defining the full contract.

## Capabilities

### New Capabilities
- `signals-trace`: OTLP trace export contract — config schema, turn buffering model, boundary detection, service.name routing, agentType normalization, gen_ai.agent.system mapping, required Resource attributes, conversion via util-genai, debug double-write, failure persistence, graceful shutdown.

### Modified Capabilities
<!-- None -->

## Impact

- **Code**:
  - `src/types/index.ts` — new `OtlpTraceFlusherConfig` interface; `FlusherConfig` gains optional `otlpTrace` field.
  - `src/normalization/agent-system-map.ts` (new) — exports `AGENT_SYSTEM_MAP` and `resolveAgentSystem(agentType)`.
  - `src/utils/agent-type-normalize.ts` (new) — exports `normalizeAgentType(raw)`.
  - `src/flushers/otlp-trace-flusher.ts` (new) — implements `BaseFlusher`. Owns turn buffering, boundary detection, per-agent provider/exporter cache, conversion, debug logger, failure logger, lifecycle.
  - `src/core/config-loader.ts` — new `buildOtlpTraceConfig` resolver.
  - `src/core/orchestrator.ts` — registration of `OtlpTraceFlusher` in `buildFlusher()`.
- **Affected Baseline Modules**:
  - `docs/modules/flushers.md` — new flusher subsection.
  - `docs/modules/types.md` — new `OtlpTraceFlusherConfig` shape.
  - `docs/modules/core.md` — `config-loader` gains `buildOtlpTraceConfig`.
  - `docs/modules/normalization.md` — new `agent-system-map`.
  - `docs/agent-onboarding-guide.md` — new step: "Maintain `AGENT_SYSTEM_MAP`."
- **Dependencies (new)**:
  - `@loongsuite/opentelemetry-util-genai` (local file dep initially, npm later)
  - `@opentelemetry/api`
  - `@opentelemetry/sdk-trace-base`
  - `@opentelemetry/resources`
  - `@opentelemetry/exporter-trace-otlp-proto`
  - `@opentelemetry/otlp-transformer` (for debug/failed-log OTLP/JSON serialization)
- **Baseline Modification**: declared. Doc updates applied as the FINAL task behind explicit human confirmation.
