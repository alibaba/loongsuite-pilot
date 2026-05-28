## 1. Types and shared modules

- [ ] 1.1 Define `OtlpTraceFlusherConfig` interface in `src/types/index.ts`: `enabled`, `endpoint`, `protocol`, `headers`, `serviceName`, `resourceAttributes?`, `captureMessageContent?`, `debug?`, `turnIdleTimeoutMs?`
- [ ] 1.2 Extend `FlusherConfig` to include optional `otlpTrace?: OtlpTraceFlusherConfig`
- [ ] 1.3 Create `src/normalization/agent-system-map.ts` with `AGENT_SYSTEM_MAP` and `resolveAgentSystem(agentType)` per design D9
- [ ] 1.4 Create `src/utils/agent-type-normalize.ts` with `normalizeAgentType(raw): string` per design D8

## 2. Dependencies

- [ ] 2.1 Add local file dependency: `"@loongsuite/opentelemetry-util-genai": "file:../../genai-util/loongsuite-js-plugins/opentelemetry-util-genai"`
- [ ] 2.2 Add to dependencies: `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/resources`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/otlp-transformer`
- [ ] 2.3 Pin OTel packages to consistent version range; verify `npm install` succeeds

## 3. Flusher implementation

- [ ] 3.1 Create `src/flushers/otlp-trace-flusher.ts` extending `BaseFlusher` (`name = 'otlp-trace'`)
- [ ] 3.2 Constructor: validate config (fail-fast on missing `endpoint` / empty `serviceName` when `enabled`); warn on empty `headers`
- [ ] 3.3 Implement `resolveGroupKey(entry)`: returns `{ source, value }` per D2 fallback chain (`turn_id` > `trace_id` > `session_id` > ephemeral)
- [ ] 3.4 Implement `TurnBuffer` data structure: `{ key, keySource, agentType, records[], completed, lastActivityMs }`
- [ ] 3.5 Implement `send(entry)`:
  - Derive groupKey via `resolveGroupKey`
  - If ephemeral: immediately `convertAndExport([entry])` (single-entry micro-turn)
  - Otherwise: check if active buffer for same agentType has different key → Signal B (mark old buffer completed, trigger flush)
  - Append to matching buffer (create if needed)
  - Check Signal A: if `gen_ai.response.finish_reasons` includes `"stop"` → mark completed, trigger flush
- [ ] 3.6 Implement `sendBatch(entries)`: loop `send`
- [ ] 3.7 Implement `flushCompleted()`:
  - Collect all completed TurnBuffers
  - For each: backfill `gen_ai.turn.id` if keySource is `trace_id` or `session_id` (per D4)
  - Call `convertAndExport(agentType, records)` per turn
  - Remove from turnBuffers map
- [ ] 3.8 Implement per-agent convert state cache (`Map<agentType, AgentConvertState>`): `BasicTracerProvider` + `ExtendedTelemetryHandler` + `InMemorySpanExporter`, with pilot's Resource per D10
- [ ] 3.9 Implement `convertAndExport(agentType, records)`:
  - Get or create AgentConvertState
  - Call `convertEventLogToTrace(records as EventLogRecord[], { handler, strict: false })`
  - `await provider.forceFlush()`; `inMem.getFinishedSpans()`; `inMem.reset()`
  - If debug: write OTLP/JSON to debug file (D14)
  - Call `exporter.export(spans, cb)` on per-agent OTLPTraceExporter
  - On failure cb: write to failed-log (D15)
- [ ] 3.10 Implement per-agent export state cache (`Map<agentType, OTLPTraceExporter>`): endpoint with `/v1/traces` normalization (D12), headers from config
- [ ] 3.11 Implement endpoint URL normalization: strip trailing slash, append `/v1/traces` if absent
- [ ] 3.12 Implement debug write (D14): OTLP/JSON serialization via `@opentelemetry/otlp-transformer`, one `ResourceSpans` per line to `otlp-debug/<svc>-YYYY-MM-DD.jsonl`; catch errors, log warn, never block export
- [ ] 3.13 Implement failed-log write (D15): same format + `_error: { code, message }` to `otlp-failed/<svc>.jsonl`
- [ ] 3.14 Implement optional idle timeout (D3 Signal D): if `turnIdleTimeoutMs > 0`, run a 1s interval scanning for idle buffers; mark completed and flush. Default 0 = disabled.
- [ ] 3.15 Implement `flush()`: mark all buffers completed, run `flushCompleted()`, await all in-flight exports
- [ ] 3.16 Implement `shutdown()`: cancel idle timer if any, call `flush()`, shutdown all per-agent exporters and providers
- [ ] 3.17 Implement `captureMessageContent` (D13): at flusher construction time, conditionally set env vars
- [ ] 3.18 Implement test seam `exportSpansForAgent(agentType, spans[])` (D17): bypasses turn buffer + converter, directly exercises export path

## 4. Config and orchestrator wiring

- [ ] 4.1 In `src/core/config-loader.ts`, add `buildOtlpTraceConfig(config): OtlpTraceFlusherConfig | undefined`
- [ ] 4.2 In `src/core/orchestrator.ts` `buildFlusher()`, conditionally instantiate `OtlpTraceFlusher` and add to MultiFlusher
- [ ] 4.3 Ensure shutdown ordering: orchestrator awaits MultiFlusher.shutdown() which awaits OtlpTraceFlusher.shutdown()

## 5. Tests

- [ ] 5.1 `tests/unit/utils/agent-type-normalize.test.ts`: normal, edge cases (uppercase, spaces, empty → unknown)
- [ ] 5.2 `tests/unit/normalization/agent-system-map.test.ts`: all ClientType values map correctly; unknown → 'unknown'
- [ ] 5.3 `tests/unit/flushers/otlp-trace-flusher/group-key.test.ts`: fallback chain priority, ephemeral case
- [ ] 5.4 `tests/unit/flushers/otlp-trace-flusher/turn-boundary.test.ts`:
  - Signal A: entry with finish_reason=stop triggers immediate flush
  - Signal B: new groupKey triggers flush of old buffer
  - Signal C: shutdown drains all
  - No false triggers: entry with finish_reason=tool_calls does NOT trigger
  - Backfill: entries converted have gen_ai.turn.id populated
- [ ] 5.5 `tests/unit/flushers/otlp-trace-flusher/conversion.test.ts`:
  - Mock util-genai `convertEventLogToTrace`; verify called with correct records
  - Verify Resource attributes on produced spans (service.name, acs.arms.service.feature, gen_ai.agent.system)
  - Verify inMem.reset() called after each conversion (no span leakage between turns)
- [ ] 5.6 `tests/unit/flushers/otlp-trace-flusher/export.test.ts`:
  - Mock OTLPTraceExporter; verify export() called with spans
  - debug=true: verify debug file written
  - Export failure: verify failed-log written with _error field
  - Both debug=true + failure: both files written
  - Endpoint /v1/traces normalization
- [ ] 5.7 `tests/unit/flushers/otlp-trace-flusher/config.test.ts`:
  - fail-fast on missing endpoint/serviceName
  - warn on empty headers
  - absent block → undefined
  - reserved resourceAttributes keys dropped with warning
- [ ] 5.8 `tests/unit/flushers/otlp-trace-flusher/lifecycle.test.ts`:
  - shutdown drains pending turns and shuts down exporters
  - exportSpansForAgent test seam works end-to-end
- [ ] 5.9 Run `npm test` — all suites pass

## 6. Integration verification

- [ ] 6.1 `npm run build` passes (typecheck OK)
- [ ] 6.2 Smoke test script `scripts/smoke-otlp-trace.ts`: create OtlpTraceFlusher with config pointing at local receiver, feed real fixture entries (from `tests/fixtures/`), verify spans exported with correct Resource and span tree structure
- [ ] 6.3 Debug verification: enable debug, run smoke, verify `otlp-debug/` file contains valid OTLP/JSON (parseable per line)
- [ ] 6.4 Failure verification: misconfigure endpoint, verify `otlp-failed/` populated with `_error`
- [ ] 6.5 CMS 2.0 connectivity: with real endpoint + license key, export mock spans, verify HTTP 200 (does NOT verify ARMS UI rendering — only transport)

## 7. Validation

- [ ] 7.1 Verify flusher follows all 6 baseline constraints in `docs/modules/flushers.md`
- [ ] 7.2 Verify constitution principles: event-driven, extensible, graceful lifecycle
- [ ] 7.3 `npm run lint` passes

## 8. Baseline doc updates (FINAL — requires human confirmation)

- [ ] 8.1 Update `docs/modules/flushers.md`: add OtlpTraceFlusher section (turn buffer model, per-agent dispatch, debug + failed-log directories)
- [ ] 8.2 Update `docs/modules/types.md`: add `OtlpTraceFlusherConfig`
- [ ] 8.3 Update `docs/modules/core.md`: note `buildOtlpTraceConfig` in config-loader
- [ ] 8.4 Update `docs/modules/normalization.md`: add `agent-system-map`
- [ ] 8.5 Update `docs/agent-onboarding-guide.md`: add "Maintain AGENT_SYSTEM_MAP" step
