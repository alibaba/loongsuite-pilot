## Context

The collector currently normalizes raw input records into `AgentActivityEntry` objects, enriches them in `InputManager`, and then dispatches them to one or more flushers. Sensitive content fields are produced by several inputs:

- `cursor-hook` maps Cursor hook payloads to `input.messages`, `input.messages_delta`, `output.messages`, `tool.arguments`, and `tool.result.payload` with `agent.type = cursor`.
- `qoder-cli-hook` and `qoder-work-hook` map transcript/hook records to legacy or standard entries that still serialize into sensitive content fields or legacy `content`/`inlineDiffMessage` fields.
- `claude-code-log` and `codex-log` forward OTel-style fields including `input.messages`, `output.messages`, and tool fields.

There is already a `redactCodeGenerationFields()` helper, but it is only applied inside `SlsFlusher` when an SLS endpoint has `redact` set. That makes deletion behavior transport-specific and leaves JSONL/HTTP outputs unchanged. The new policy needs to live in the input collection path so all downstream outputs receive the same sanitized entry.

## Goals / Non-Goals

**Goals:**

- Parse a top-level `agents` object from `~/.loongsuite-pilot/config.json` using the current first-stage user-facing schema:

```json
{
  "agents": {
    "cursor": {
      "captureMessageContent": "true"
    },
    "qoder": {
      "captureMessageContent": "true"
    }
  }
}
```

- Key policy lookup by normalized `agent.type`, not input id, so all inputs for the same agent share one policy.
- Default missing settings to sensitive content upload enabled.
- Apply policy before entries reach any flusher.
- Delete sensitive content fields when upload is disabled.
- Keep processing fail-open: malformed config values or policy errors must not crash collection.

**Non-Goals:**

- Building a deep semantic PII detector for message/tool content.
- Changing hook processors to stop writing local raw history files.
- Changing whether non-sensitive metadata, usage, costs, model names, sessions, and event IDs are reported.
- Adding per-field user configuration in the first version.
- Adding per-field masking behavior.
- Adding workspace exclusion behavior.

## Decisions

### Decision 1: Add `agents` to `AnalyticsConfig`

`config-loader.ts` should parse `ConfigFile.agents` into a typed internal config, for example:

```typescript
export interface AgentsConfig {
  [agentType: string]: AgentConfig;
}

export interface AgentConfig {
  captureMessageContent: boolean;
}
```

The on-disk file uses the user's final field names. The loader should accept both JSON booleans and string booleans (`"true"` / `"false"`) because the chosen example uses strings. Invalid or missing values fall back per field:

- `captureMessageContent`: `true`

Alternative considered: apply raw config lookups directly in inputs. Rejected because every input would need duplicate parsing and default logic.

### Decision 2: Apply policy in `InputManager`

`InputManager.handleEntries(inputId, entries)` is the right input-layer boundary. At that point:

- every record is already mapped into an `AgentActivityEntry`;
- `entry['agent.type']` is available for policy lookup;
- the manager already enriches user identity before dispatch;
- all flushers receive the same policy-applied entries.

The orchestrator should pass `config.agents` into `InputManager` during startup.

Alternative considered: apply policy in each `transformRecord()` implementation. Rejected because it would duplicate the sensitive field list and would not guarantee consistent behavior across inputs.

Alternative considered: apply policy in `serialiseLogEntry()` or each flusher. Rejected because the policy is conceptually collector input output, and flusher-specific handling caused the current SLS-only limitation.

### Decision 3: Define one shared sensitive field set

Create a small helper module such as `src/normalization/agent-content-policy.ts` that owns:

- the sensitive field set:
  - `input.messages`
  - `input.messages_delta`
  - `output.messages`
  - `tool.arguments`
  - `tool.result.payload`
  - legacy `content`
  - legacy `inlineDiffMessage`
- policy lookup by `agent.type`;
- delete mutation on a copy of the entry.

`captureMessageContent=false` deletes the sensitive fields. `captureMessageContent=true` preserves them.

Alternative considered: reuse `redactCodeGenerationFields()` directly. Rejected because it operates on serialized string maps and is named around legacy code-generation behavior, while the new policy needs to work on typed entries before all flushers.

### Decision 4: Preserve existing SLS endpoint redaction temporarily

The existing SLS endpoint `redact` behavior can remain for compatibility. It may delete the same fields again after serialization, which is idempotent. The new `agents` policy is the primary path for user-controlled content upload handling across JSONL, SLS, and HTTP.

## Risks / Trade-offs

- Unknown future agent fields may appear in user-authored config examples -> the loader should ignore unsupported fields for this stage rather than failing.
- SLS endpoint redaction remains as a second redaction path -> safe because deletion is idempotent, but future cleanup can deprecate endpoint-level `redact` once the config policy is established.

## Migration Plan

1. Add config parsing and defaults. Existing users without `agents` keep current behavior.
2. Add the shared agent content policy helper and unit tests.
3. Wire the policy into `InputManager` through `Orchestrator`.
4. Keep existing SLS endpoint redaction unchanged during rollout.
