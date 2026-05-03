## Why

Qoder, Qoder CLI, and Cursor logs can emit records without `request.model` or `response.model` when the raw payload does not expose a reliable model value. Downstream SLS dashboards and queries need these columns to exist consistently, even when the only safe value is `unknown`.

## What Changes

- For every emitted `AgentActivityEntry` with `agent.type = qoder`, `qoder-cli`, or `cursor`, ensure:
  - `request.model` is populated.
  - `response.model` is populated.
- Apply this to Qoder transcript hook output (`attributes.source = qoder-transcript-hook`).
- Apply this to Qoder SQLite token usage output (`attributes.source = qoder-sqlite-chat-message`).
- Apply this to Qoder CLI session segment output (`attributes.source = qoder-cli-session-segment`).
- Apply this to Cursor hook output (`agent.type = cursor`).
- Preserve real model values when available; otherwise use `unknown`.
- Do not attempt to infer model values from unreliable fields in this change.

## Capabilities

### New Capabilities
- `qoder-model-defaults`: Ensure Qoder, Qoder CLI, and Cursor outputs always include `request.model` and `response.model`, defaulting missing values to `unknown`.

### Modified Capabilities

## Impact

- Updates `QoderCliInput` mapping for rows inferred as `agent.type = qoder`.
- Updates `QoderCliInput` and `QoderCliSessionInput` fallback model behavior for `agent.type = qoder-cli`.
- Updates `QoderSqliteInput` mapping for SQLite token usage rows.
- Updates `CursorHookInput` fallback model behavior.
- Adds tests ensuring Qoder, Qoder CLI, and Cursor outputs consistently include model fields while preserving real model values when available.
