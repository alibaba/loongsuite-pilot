## 1. Field Boundary Assessment

- [x] 1.1 Inventory Cursor hook payload fields currently mapped in `CursorHookInput` and classify each as hook-owned by default, collector-owned, technically unavailable from hook input, or legacy fallback-only.
- [x] 1.2 Inventory Qoder CLI/Qoder Work transcript and hook payload fields currently mapped in `QoderCliInput` and classify each as hook-owned by default, collector-owned, technically unavailable from hook input, or legacy fallback-only.
- [x] 1.3 Document fields that are duplicated in hook and collector logic, including `user.id` defaulting, provider fallback, and content-policy filtering, and define which side is authoritative.
- [x] 1.4 Document fields that must stay in input/normalization because they require cross-record state, runtime environment enrichment, or final schema cleanup.
- [x] 1.5 Document fields that are technically possible in hooks but intentionally collector-owned for architecture consistency.

## 2. Asset Hook Processor Normalization

- [x] 2.1 Add a dependency-free shared asset-side normalizer in `assets/hooks` for canonical timestamp, event ID, JSON sanitization, namespaced raw context, deterministic event name mapping, canonical record construction, user defaulting, provider fallback, content-policy filtering, and common tool/status/error mapping.
- [x] 2.2 Update `assets/hooks/cursor-hook-processor.mjs` to use the shared normalizer and emit standard-compatible records from Cursor hook stdin while preserving fail-open behavior.
- [x] 2.3 Update the Qoder hook processor path to use the shared normalizer and normalize supported transcript rows and hook payload rows before appending history JSONL.
- [x] 2.4 Map all deterministic hook-time fields to canonical dotted keys, including explicit model/provider, token/cost, finish reason, message, tool argument/result, duration, status, and error fields when present.
- [x] 2.5 Apply hook-side best-effort `user.id` defaulting, provider fallback from model names, and content-policy filtering before appending history JSONL.
- [x] 2.6 Ensure unsupported or partially mapped source fields are retained under an `agent.<source>.*` namespace without duplicating converted source keys.

## 3. Hook Input Compatibility

- [x] 3.1 Update `CursorHookInput` to prefer canonical dotted keys and use existing Cursor raw payload parsing only as fallback.
- [x] 3.2 Update `QoderCliInput` to prefer canonical dotted keys and use existing Qoder transcript/hook parsing only as fallback.
- [x] 3.3 Keep `BaseHookInput` responsibilities limited to tailing, checkpointing, JSONL parsing, and delegating record transformation.
- [x] 3.4 Verify final entries still pass through `buildAgentActivityEntry()` and collector normalization for authoritative defaults, alias cleanup, provider inference, and content policy.

## 4. Tests and Verification

- [x] 4.1 Add unit tests for Cursor processor output covering tool call, tool result, LLM request/response, invalid JSON, and append failure behavior.
- [x] 4.2 Add unit tests for Qoder processor output covering assistant, user, tool call, tool result, ignored row, and missing transcript behavior.
- [x] 4.3 Add input tests proving canonical hook rows and legacy hook rows emit equivalent `AgentActivityEntry` semantics.
- [x] 4.4 Add tests proving hook-side content policy is applied before history write and collector-side content policy remains authoritative after history read.
- [x] 4.5 Add or update replay/integration tests to verify history JSONL remains append-only and checkpoint behavior is unchanged.
- [x] 4.6 Run typecheck and relevant vitest suites for hooks, inputs, normalization, and replay.

## 5. Documentation

- [x] 5.1 Update `assets/hooks/README.md` with the final hook record contract and field ownership guidance.
- [x] 5.2 Update `docs/modules/hooks.md` to document the shared asset-side normalizer, default hook ownership of deterministic per-event normalization, and best-effort hook-side user/provider/content-policy logic.
- [x] 5.3 Update `docs/modules/normalization.md` to document collector-side authoritative final build, provider fallback, content policy, and schema cleanup responsibilities after hook-side pre-standardization.
- [x] 5.4 Re-run a baseline impact check against `docs/constitution.md`, `docs/modules/hooks.md`, and `docs/modules/normalization.md` before marking the change complete.
