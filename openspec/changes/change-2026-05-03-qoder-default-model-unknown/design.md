## Context

Qoder, Qoder CLI, and Cursor are emitted as distinct `agent.type` values. Some sources include real model names, while others do not. Observed Qoder IDE transcript rows do not include a reliable model field, Qoder SQLite token usage rows do not parse model fields, and Cursor/Qoder CLI lifecycle/tool rows may be missing model values.

SLS dashboards expect `request.model` and `response.model` columns to be present. When a real model is unavailable, the safest current value is a deliberate placeholder: `unknown`.

## Goals / Non-Goals

**Goals:**
- Ensure every `agent.type = qoder` entry includes `request.model` and `response.model`.
- Ensure every `agent.type = qoder-cli` entry includes `request.model` and `response.model`.
- Ensure every `agent.type = cursor` entry includes `request.model` and `response.model`.
- Preserve real model values when present.

**Non-Goals:**
- Do not infer real Qoder IDE model names from unreliable transcript fields.
- Do not parse SQLite `model_info` in this change.
- Do not overwrite real Qoder CLI or Cursor model values with `unknown`.

## Decisions

### Default at the mapper boundary

Each mapper should set model defaults at the point it emits a normalized entry:

- `QoderCliInput` should use a real transcript model when present and `unknown` otherwise.
- `QoderCliSessionInput` should use a real segment model when present and `unknown` otherwise.
- `QoderSqliteInput` should emit `request.model = unknown` and `response.model = unknown`.
- `CursorHookInput` should use a real Cursor model when present and `unknown` otherwise.

Alternative considered: add a post-processing normalization rule for all missing model fields. That risks changing unrelated agents where missing model may mean something different.

### Always set both request and response model

Even though some rows are `llm.request` or `tool.*`, this change intentionally sets both model fields for Qoder, Qoder CLI, and Cursor output so SLS dashboards can consistently group and filter records.

Alternative considered: set only `response.model` for `llm.response`. That would not satisfy the requirement that every final log output include both model columns for these agents.

### Preserve real model values

Rows emitted with real model values should keep them and should not be overwritten with `unknown`.

## Risks / Trade-offs

- `unknown` is not a real model -> This is intentional and easier to query than a missing column.
- If Qoder later exposes reliable model values -> A future change can replace `unknown` with real parsing while preserving the column presence contract.
- Setting both fields on non-response rows may look redundant -> The goal is SLS schema consistency for Qoder records.

## Migration Plan

1. Update `QoderCliInput` model assignment defaults.
2. Update `QoderCliSessionInput` model assignment defaults.
3. Update `QoderSqliteInput` to set both model fields to `unknown`.
4. Update `CursorHookInput` model assignment defaults.
5. Add/update tests for Qoder, Qoder CLI, and Cursor outputs.
6. Run focused tests, typecheck, lints, and full suite.
