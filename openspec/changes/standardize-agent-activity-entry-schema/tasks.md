## 1. Contract And Helpers

- [x] 1.1 Update `AgentActivityEntry` in `src/types/events.ts` to use section-3 canonical fields and types, including `gen_ai.turn.id`, `gen_ai.step.id`, `gen_ai.agent.*`, `gen_ai.usage.*_cost`, `gen_ai.tool.call.exec.id`, `gen_ai.tool.call.duration_ms`, and `gen_ai.response.finish_reasons` as `string[]`; omit `gen_ai.message.role` and `is_error` from canonical output.
- [x] 1.2 Update `AgentEventName` to the current enum: `llm.request`, `llm.response`, `tool.call`, `tool.result`, `skill.use`, `tool.approve`, and `other`.
- [x] 1.3 Add shared normalization helpers for reading canonical-or-legacy aliases, normalizing event names, normalizing finish reasons, and converting unknown values to `JsonValue`.
- [x] 1.4 Implement `inferProviderName()` with explicit-provider precedence, model-name rules, source/agent fallback rules, and a stable unknown fallback.
- [x] 1.5 Update `buildAgentActivityEntry()` so legacy options and old standard option keys produce section-3 canonical entries.

## 2. Serialization And Policy

- [x] 2.1 Update `serialiseLogEntry()` to serialize canonical fields and omit legacy shortened aliases from new output.
- [x] 2.2 Update `redactCodeGenerationFields()` to redact canonical sensitive fields plus legacy aliases.
- [x] 2.3 Update `applyContentDataPolicy()` to delete canonical sensitive fields plus legacy aliases when upload is disabled.
- [x] 2.4 Update content policy lookup to use `gen_ai.agent.type` first and legacy `agent.type` as an input-compatibility fallback.
- [x] 2.5 Ensure `InputManager` user enrichment still works with canonical entries and does not reintroduce legacy field names.

## 3. Input Migrations

- [x] 3.1 Update `CursorHookInput` to emit section-3 canonical fields while accepting current raw Cursor hook fields and legacy shortened keys.
- [x] 3.2 Update `QoderCliInput` transcript/hook normalization to emit canonical fields, infer provider, map old `event` names to `other`, represent failures via error fields, and accept old transcript keys.
- [x] 3.3 Update `QoderSqliteInput` to emit canonical usage/model/session/provider fields from SQLite token rows.
- [x] 3.4 Update `QoderCliSessionInput` to emit canonical usage/model/session/provider fields from session segment logs.
- [x] 3.5 Update `ClaudeCodeLogInput` and `CodexLogInput` to accept old OTel-like shortened log keys and emit section-3 canonical fields.
- [x] 3.6 Review any remaining inputs or tests using legacy field names and migrate production code to canonical names.

## 4. Tests And Fixtures

- [x] 4.1 Update `tests/contract/agent-activity-schema.ts` and contract tests to require section-3 canonical fields, including `gen_ai.agent.type` and `event.name = other` for miscellaneous events.
- [x] 4.2 Update normalization serialization tests to assert canonical output and legacy alias omission.
- [x] 4.3 Update content data policy tests to cover canonical sensitive fields, `gen_ai.agent.type` policy lookup, and legacy aliases.
- [x] 4.4 Update input unit tests for Cursor, Qoder CLI, Qoder SQLite, Qoder CLI session, Claude Code, and Codex to assert canonical fields.
- [x] 4.5 Add explicit legacy-input compatibility tests that feed old shortened fields and verify canonical normalized entries.
- [x] 4.6 Update integration tests and fixtures where expected output still references legacy field names.

## 5. Verification

- [x] 5.1 Run focused tests for contract, normalization, content policy, inputs, and hook JSONL flow.
- [x] 5.2 Run the repository typecheck or full test command used by the project.
- [x] 5.3 Inspect serialized sample output to confirm new records contain canonical field names and no duplicate legacy aliases.
- [x] 5.4 Run `openspec validate standardize-agent-activity-entry-schema --strict` and resolve any issues.
