## Context

The collector now has two Qoder-related normalized streams that can emit model response activity:

- `QoderCliSessionInput` reads Qoder CLI native session segment rows such as `model.response.completed`.
- `QoderCliInput` reads the shared Qoder transcript hook history and maps both Qoder CLI-like and Qoder IDE-like transcript rows.
- `QoderSqliteInput` reads Qoder SQLite `chat_message` token usage rows.

Recent inspection clarified that several raw fields are not canonical identifiers for the standard `AgentActivityEntry` columns:

- Qoder CLI segment `turn_id` and `loop_id` are useful source metadata but should not be treated as standard `turn.id` or `step.id`.
- Qoder CLI segment `request_id` is source-specific and should remain diagnostic metadata rather than being exposed as a standard request or response id.
- Qoder transcript assistant `message.id` is the best available response identifier and should be promoted to `response.id`.
- Qoder IDE transcript rows do not provide a reliable `request.id`, so that field should be omitted.
- Qoder SQLite `chat_message.request_id` is source-specific and should remain diagnostic metadata rather than being exposed as `request.id`.

## Goals / Non-Goals

**Goals:**
- Remove misleading standard identifiers from Qoder output.
- Promote only known transcript response identifiers into `response.id`.
- Keep raw/source ids in `attributes` when they are useful diagnostically but not standard semantics.
- Update tests to assert absence of unsupported identifiers.

**Non-Goals:**
- Do not invent turn, step, or request identifiers from parent ids, prompt ids, loop ids, or message ids.
- Do not change hook installation, processor behavior, listener ids, or history paths.
- Do not change token usage field semantics.

## Decisions

### Prefer omission over incorrect identifier mapping

If a raw Qoder field cannot be confidently mapped to a standard identifier, the mapper should omit the standard field and preserve the raw value in `attributes` if useful.

Alternative considered: continue filling best-effort fields for easier joins. This makes downstream analytics misleading because the same standard column would contain non-equivalent identifiers from different sources.

### Qoder CLI session segment identifiers

For `model.response.completed` segment rows:

- `request_id` is preserved in `attributes`.
- `request.id` is omitted.
- `response.id` is omitted.
- `turn.id` is omitted.
- `step.id` is omitted.
- Raw `turn_id`, `loop_id`, `request_id`, and request index remain eligible for `attributes`.

Alternative considered: map segment `request_id` to `response.id`. This is still too strong for the observed source semantics, so the value remains diagnostic only.

### Qoder transcript hook identifiers

For assistant response rows from the shared transcript hook:

- `message.id` maps to `response.id` when present.
- Qoder IDE rows omit `request.id`.
- Qoder CLI rows also avoid synthesized `turn.id`; no current CLI transcript field is considered canonical for `turn.id`.
- Parent ids, prompt ids, and message ids remain eligible for `attributes`.

Alternative considered: map `promptId` to `turn.id` for CLI transcript rows. Inspection showed it does not represent the canonical turn identity, so it should stay diagnostic only.

### Qoder SQLite token usage identifiers

For `chat_message` token usage rows:

- `request_id` is preserved in `attributes`.
- `request.id` is omitted.
- Message id remains available as `event.id` and `attributes.message_id`.

Alternative considered: keep SQLite `request_id` in `request.id`. This creates inconsistent request semantics across Qoder streams, so the value remains diagnostic only.

## Risks / Trade-offs

- Some dashboards may currently group on `request.id` or `response.id` for Qoder CLI session output -> They should use raw diagnostic attributes or wait for canonical ids.
- Removing `turn.id` / `step.id` reduces apparent relational richness -> This is intentional to avoid false joins.
- Raw ids remain available in attributes but are less convenient for SLS columns -> Only semantically stable identifiers should occupy standard columns.

## Migration Plan

1. Update Qoder session segment mapper field assignments.
2. Update Qoder transcript hook mapper field assignments.
3. Update Qoder SQLite mapper field assignments.
4. Update tests to verify unsupported identifiers are absent and response ids are present.
5. Run Qoder-focused tests, typecheck, and the full suite before archiving.

## Open Questions

- If Qoder later exposes canonical turn/request ids, should they be mapped into standard fields in a follow-up change?
