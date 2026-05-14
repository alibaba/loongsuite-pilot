## Context

The current hook pipeline writes Cursor and Qoder hook/transcript data into local history JSONL, then `BaseHookInput` subclasses parse source-specific shapes into `AgentActivityEntry` records. This keeps the collector pipeline intact, but it means replayed history is not itself close to the AI agent event contract and each input owns both tailing and source interpretation.

The baseline already allows asset hook processors to perform source-specific extraction and lightweight normalization, with strict constraints: processors must fail open, write append-only local files only, and never bypass Input -> InputManager -> Flusher. This change uses that existing boundary rather than introducing a new pipeline.

## Goals / Non-Goals

**Goals:**

- Make Cursor and Qoder-family hook history JSONL standard-compatible where the hook payload or transcript row provides enough information.
- Move deterministic per-event normalization from hook inputs into asset hook processors by default.
- Duplicate selected collector enrichment and policy logic in hooks when practical, including user defaults, provider fallback, and content-policy filtering.
- Share hook-side normalization code across Cursor and Qoder processors instead of duplicating mapping logic in each processor.
- Reduce source-specific mapping in `CursorHookInput` and `QoderCliInput` by making them prefer canonical dotted keys.
- Preserve legacy raw/transcript parsing as fallback until existing history formats are no longer needed.
- Document the smaller set of fields that must remain input-side because they require cross-record state, runtime enrichment, or final schema cleanup.
- Keep hooks deterministic and fail-open.

**Non-Goals:**

- Changing the `AgentActivityEntry` schema or adding new event names.
- Sending data from hooks directly to SLS, HTTP, JSONL flushers, or `InputManager`.
- Removing replay support for old hook history logs in the same implementation step.
- Replacing collector-side final `AgentActivityEntry` building, validation, or authoritative policy enforcement.

## Decisions

### Processor output is a standard-compatible hook record, not the final entry

Processors will emit records with canonical dotted keys such as `event.name`, `user.id`, `gen_ai.session.id`, `gen_ai.agent.type`, `gen_ai.provider.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `error.*`, `time_unix_nano`, and `observed_time_unix_nano`. Inputs will still pass the record through `buildAgentActivityEntry()` so final defaults, alias cleanup, provider inference fallback, and content policy remain authoritative in the collector.

Alternative considered: have hook processors emit final `AgentActivityEntry` objects and let inputs forward them directly. That would duplicate normalization rules in JavaScript assets and weaken the existing pipeline boundary.

### Source raw context stays namespaced

Processors will put unmapped source-specific payload fragments under `agent.<source>.*` instead of keeping ad hoc top-level fields. Source keys that have already been mapped into canonical fields will not be duplicated in source namespaces. This keeps stable query fields canonical while preserving useful context for replay/debugging.

Alternative considered: keep the current raw top-level payload and add canonical keys beside it. That is easier short term, but it makes the history contract ambiguous and encourages new consumers to rely on source-specific keys.

### Field ownership is split by availability and risk

Hook processors will own all deterministic per-event normalization that can be derived from stdin payloads or transcript rows without cross-record state. This includes event kind, source agent type, session/turn/tool identifiers, observed timestamps, generated event IDs, explicit model/provider values, token/cost fields, finish reasons, tool arguments/results, tool status, duration, and error fields when those source values are present.

Hook processors will also duplicate a small, dependency-free subset of collector enrichment/policy logic where practical: `user.id` defaulting from hook payload/environment/local OS context, provider fallback from model names, and content-policy filtering for message/tool content fields. The collector will re-apply these as the authoritative final pass.

Inputs and normalization will retain only fields or transformations that require cross-record inference or collector runtime enrichment: checkpoint state, final schema validation/alias cleanup, authoritative policy enforcement, git/workspace/host enrichment, trace tree construction, and any correlation that needs historical state.

Alternative considered: centralize all mapping in a shared source-normalization library imported by both assets and `src`. That may be useful later, but the current asset scripts are installed standalone and should remain small, deterministic, and dependency-light.

### Hook-side normalization is shared inside assets

The hook runtime and collector runtime may keep separate normalization entrypoints because asset scripts are installed and executed independently from TypeScript source modules. Within the hook runtime, Cursor and Qoder processors will share a dependency-free asset-side normalizer such as `assets/hooks/agent-event-normalizer.mjs` or `assets/hooks/normalization-utils.mjs`.

That helper will own common logic for timestamp conversion, event ID generation, source hook event name mapping, safe JSON parsing, canonical dotted-key construction, raw context namespacing, user defaulting, provider fallback, content-policy filtering, and common tool/status/error mapping. Source processors will provide source-specific extraction only.

Alternative considered: duplicate equivalent helpers inside each processor. That would be simpler initially, but it would make event name mapping and canonical field behavior drift between Cursor and Qoder.

### Migration is prefer-canonical with fallback

`CursorHookInput` and `QoderCliInput` will first detect canonical records and build entries from those keys. If a record is legacy raw Cursor payload or Qoder transcript row, the existing parsing paths will continue to run. Tests will cover both modes.

Alternative considered: switch the input parser in one breaking step. That would simplify code faster but would make existing history logs unreplayable and make rollback harder.

## Risks / Trade-offs

- [Risk] Hook processors become too complex and slow in the agent hook path. -> Mitigation: keep mapping lightweight, avoid external dependencies, and retain fail-open behavior with local error logs.
- [Risk] Sensitive tool arguments or outputs are copied into canonical fields before policy runs. -> Mitigation: run a hook-side best-effort content policy before writing history and re-apply collector-side policy as the authoritative final pass.
- [Risk] Cursor and Qoder payload shapes differ across versions. -> Mitigation: preserve useful unmapped `agent.<source>.*` context and legacy fallback parsing, and add processor fixture tests for known shapes.
- [Risk] Duplicated mapping and policy logic exists between hook runtime and collector runtime. -> Mitigation: allow separate runtime entrypoints, require hook processors to share one asset-side normalizer, and keep collector-side final building/policy in `buildAgentActivityEntry()` and normalization modules.
- [Risk] Legacy fallback keeps duplicated source mapping longer than needed. -> Mitigation: make canonical parsing the first path, then delete fallback only after compatibility requirements are explicitly retired.

## Migration Plan

1. Add a shared dependency-free asset-side normalization helper for timestamp, event ID, safe JSON parsing, canonical record construction, source raw namespacing, event-name mapping, user defaulting, provider fallback, content-policy filtering, and common tool/status/error mapping.
2. Update Cursor hook processing to emit canonical records directly from hook stdin.
3. Update Qoder transcript forwarding to normalize supported transcript rows and hook payload rows before appending history.
4. Update hook inputs to prefer canonical dotted keys and retain current parsing as fallback.
5. Update baseline documentation for the hook and normalization module boundary after the implementation settles.
6. Add unit tests for processor output, input canonical handling, input fallback handling, and replay semantics.
7. Roll back by reverting processor canonical emission while leaving input fallback paths intact.

## Baseline Documentation Sync

This change should update baseline docs as part of implementation, not as a separate afterthought. `specs/baseline/modules/hooks.md` should describe the shared asset-side normalizer and the default ownership of deterministic hook-time mapping, including best-effort user defaulting, provider fallback, and content-policy filtering. `specs/baseline/modules/normalization.md` should describe collector-side final building and authoritative policy responsibilities after hook-side pre-standardization.

## Open Questions

- Whether Qoder transcript rows should continue to be copied one-to-one for every row type, or whether unsupported rows should be skipped by the processor and only logged in debug output.
- Whether full tool arguments/results should remain in hook history by default, or be replaced by hashes when the source payload is large or likely to contain code.
