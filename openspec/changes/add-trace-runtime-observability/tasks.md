## 1. Shared contracts and runtime identity

- [x] 1.1 Define the optional input/flusher batch context, aligned per-entry logical byte sizes, source-read measurements, window records, turn records, threshold types, release reasons, and result enums in a dedicated Trace runtime types module.
- [x] 1.2 Extract the existing `instance_id` and `run_id` construction into one shared runtime-identity helper, inject the same identity into `MetricsCollector` and Trace runtime reporting, and preserve the current `pilot_status` values.
- [x] 1.3 Add a typed, optional metadata argument to the BaseInput `entries` emission path so existing inputs remain source-compatible while participating inputs can attach source-read measurements.
- [x] 1.4 Extend `BaseFlusher.send()` / `sendBatch()` with optional runtime batch context and make `MultiFlusher` forward it unchanged while allowing every existing flusher to ignore it.

## 2. Trace runtime observer

- [x] 2.1 Implement `TraceRuntimeObserver` with lightweight per-turn state for identifiers, input dimension, current and peak records/bytes, source/produced bytes, first/last monotonic timestamps, threshold bits, and stage results without retaining event or Span objects.
- [x] 2.2 Implement constant-time append and release accounting, size thresholds at 64 MiB / 256 MiB / 1 GiB, lifetime thresholds at 30 minutes / 2 hours, and once-per-turn-per-tier detail deduplication.
- [x] 2.3 Implement per-`agent_type + input_name` ten-minute accumulators, six completed-turn size buckets, current largest/oldest active-turn gauges, conversion/export totals and maxima, and drain semantics for window counters.
- [x] 2.4 Implement the bounded 1024-record turn-detail queue, oldest-record eviction, `detail_dropped_count`, 30-second drain access, and graceful-shutdown drain access.
- [x] 2.5 Build runtime records through an explicit field whitelist and reject message, tool, file-content, event-body, and other user-content values from the observer API.

## 3. InputManager and orchestrator wiring

- [x] 3.1 Refactor `InputManager` output sizing so one serialization pass produces both the existing batch total and an aligned per-event byte array after masking and expansion.
- [x] 3.2 Forward `input_name`, aligned event sizes, and optional source reads to the flusher context; on invalid alignment, warn and skip diagnostic byte attribution without failing dispatch.
- [x] 3.3 Create one runtime identity and one `TraceRuntimeObserver` in Orchestrator, inject them into `InputManager`, `OtlpTraceFlusher`, `MetricsCollector`, and `MetricsWriter`, and keep the observer optional/fail-open.

## 4. OTLP turn, conversion, and export instrumentation

- [x] 4.1 Register each actual OTLP buffer creation and append with the observer using the flusher's existing buffer key and boundary-derived Agent/session/turn/trace identifiers.
- [x] 4.2 Map normal terminal, group successor, forced buffer-limit release, idle timeout, and incomplete shutdown paths to stable `release_reason` and `boundary_signal` values without changing the existing boundary decisions.
- [x] 4.3 Measure conversion with a monotonic clock, sample RSS and heap immediately before and after conversion cleanup, report converted Span count, and report `convert_failed` while preserving current failure isolation.
- [x] 4.4 Measure per-turn export wall time across all parallel destinations, aggregate destination outcomes into `success` or `export_failed`, and report final release only after the turn outcome is known.
- [x] 4.5 Remove active observer state after release and ensure observer callbacks, malformed context, or reporting failures cannot reject `sendBatch()`, conversion, export, or shutdown.

## 5. Codex and Qoder source-byte attribution

- [x] 5.1 Instrument `codex-transcript` existing byte-range reads to emit turn-correlated actual read bytes with `source_bytes_basis=bytes_read`, including real repeated reads and without rereading the transcript for metrics.
- [x] 5.2 Instrument `qoder-trace` existing JSONL tail loop to aggregate consumed line bytes by emitted turn with `source_bytes_basis=offset_delta`, preserving newline/offset accounting and without a second file pass.
- [x] 5.3 Route source bytes that lack reliable turn identifiers to the matching window's `source_bytes_unattributed` and omit exact source-byte fields from affected turn details.

## 6. Runtime topic reporting

- [x] 6.1 Add a 30-second MetricsWriter cycle that drains queued turn details, flattens approved fields, and calls `sendStatus('pilot_trace_runtime', ...)` without blocking normal metrics cycles.
- [x] 6.2 Add a ten-minute MetricsWriter cycle that emits one `window` record per active dimension, and emit non-empty partial windows plus pending details during graceful shutdown.
- [x] 6.3 Preserve the open-source no-op sender boundary and verify Trace runtime data never falls back to `MultiFlusher`, AgentActivityEntry, OTLP spans, or user-configured outputs.

## 7. Verification

- [x] 7.1 Add observer unit tests for incremental watermarks, all five thresholds, multi-tier crossing, deduplication, six size buckets, window drain/current gauges, abnormal small-turn details, normal small-turn suppression, and detail-queue overflow.
- [x] 7.2 Extend InputManager and MultiFlusher tests to verify input identity and aligned sizes propagate once, existing flushers remain compatible, and malformed diagnostic context does not affect dispatch.
- [x] 7.3 Extend OTLP flusher tests with fake clocks, memory samplers, converters, and exporters to verify release reasons, before/after samples, stage boundaries, multi-destination wall time/result aggregation, and unchanged turn/export behavior when the observer is absent or throws.
- [x] 7.4 Extend Codex and Qoder input tests to verify exact read/offset byte attribution, repeated-read semantics, per-turn grouping, and explicit un-attributed fallback.
- [x] 7.5 Add serialization/privacy tests proving `pilot_trace_runtime` carries raw correlation IDs and numeric diagnostics but never message, tool, file-content, or event-body fields.
- [x] 7.6 Add a regression/performance guard proving runtime accounting consumes precomputed event sizes and never traverses or reserializes buffered records, rereads transcripts, creates heap snapshots, or enables CPU profiling.
- [x] 7.7 Run the focused unit and integration suites for inputs, InputManager, metrics, MultiFlusher, and OTLP Trace, then run the repository typecheck and existing standard test command; document any unrelated pre-existing failures separately.

## 8. Contract and baseline review

- [x] 8.1 Verify sample `window`, threshold, successful release, conversion-failed, and export-failed records against the OpenSpec field semantics and confirm they can join `pilot_status` by `run_id + instance_id + time`.
- [x] 8.2 Verify implementation conforms to baseline constraints and confirm `docs/ai_event_schema.md` remains unchanged because runtime diagnostics do not enter `AgentActivityEntry`.
- [x] 8.3 Run local end-to-end verification only when initiated by the user, following `specs/local-e2e-testing-guide.md`, and compare diagnostic volume plus Pilot CPU/RSS against a control run.
- [x] 8.4 FINAL — Update or restore baseline documentation for Core/Input, Flushers/Trace, and Metrics/Monitor responsibilities, and update `docs/overview.md`, `docs/trace-input-development-guide.md`, and `docs/trace-output.md` as applicable; this task requires explicit human confirmation.

## Verification notes

- 2026-09-02: Typecheck, production build, strict OpenSpec validation, and the focused InputManager, input, metrics, MultiFlusher, OTLP runtime, and Orchestrator suites passed.
- 2026-09-02: On the latest GitHub `main`, the standard `npm test` command completed with 3,996 passed, 56 skipped, and no failures across 308 test files.
- 2026-09-02: Runtime record contract tests cover window, threshold, successful large-turn release, conversion failure, export failure, raw identifiers, privacy exclusions, and equality of `run_id` / `instance_id` with `pilot_status` plus adjacent `__time__`.
- 2026-09-02: `docs/ai_event_schema.md` and `AgentActivityEntry` remain unchanged. Runtime fields travel only through the optional internal input/flusher context and the internal status sender.
- 2026-09-02: User-initiated Docker `install-smoke` passed installation, service startup, Codex/Claude/Qwen probes, strict validation of 10 JSONL events, required Agent coverage, file-tail incremental reads, rename/copytruncate rotation, and SLS delivery. The first attempt's only failure was missing Qoder JSONL because the configured Qoder PAT had expired; Qoder source attribution remains covered by focused deterministic tests.
- 2026-09-02: A seven-run Node 22.22.2 control comparison over 200,000 serialized events measured median incremental diagnostics cost of 38.938 ms CPU (about 0.195 microseconds/event) and 1 MiB peak RSS delta. Normal small turns emitted one 1,203-byte ten-minute window record for the dimension; a simulated 300 MiB turn emitted four records totaling 3,282 bytes (64 MiB threshold, 256 MiB threshold, release, and window).
- 2026-09-02: The user explicitly confirmed baseline documentation should remain unchanged for this change; no project documentation was updated.
