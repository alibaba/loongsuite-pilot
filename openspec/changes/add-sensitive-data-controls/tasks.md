## 1. Config & Types

- [x] 1.1 Add `ContentDataConfig` and `ContentDataAgentPolicy` types to `src/types/index.ts`, and add `contentData: ContentDataConfig` to `AnalyticsConfig`.
- [x] 1.2 Extend the private `ConfigFile` shape in `src/core/config-loader.ts` with top-level `contentData?: Record<string, { uploadEnabled?: boolean | string }>` using the current first-stage user-facing field name.
- [x] 1.3 Implement `buildContentDataConfig()` in `src/core/config-loader.ts` with default `uploadEnabled=true`.
- [x] 1.4 Ensure config parsing accepts JSON booleans and string booleans (`"true"` / `"false"`), and falls back to defaults for invalid values.
- [x] 1.5 Wire `buildContentDataConfig()` into `loadConfig()` so all runtime config includes a normalized content-data policy map.

## 2. Content Data Policy Helper

- [x] 2.1 Create `src/normalization/content-data-policy.ts` with a shared content field set covering `input.messages`, `input.messages_delta`, `output.messages`, `tool.arguments`, `tool.result.payload`, legacy `content`, and legacy `inlineDiffMessage`.
- [x] 2.2 Implement `applyContentDataPolicy(entry, config)` to return a policy-applied copy of an `AgentActivityEntry` without mutating the caller's entry.
- [x] 2.3 Implement upload-disabled behavior that deletes sensitive fields and leaves non-sensitive metadata intact.
- [x] 2.4 Implement upload-enabled behavior that preserves sensitive fields unchanged.
- [x] 2.5 Ignore unsupported policy fields such as `maskEnabled` and `excludedWorkspace` for this stage without failing policy application.

## 3. Input-Layer Integration

- [x] 3.1 Add a `setContentDataConfig()` method or constructor option to `InputManager`.
- [x] 3.2 Apply `applyContentDataPolicy()` inside `InputManager.handleEntries()` after user id enrichment and before `dispatchEntries()`.
- [x] 3.3 Pass `config.contentData` from `Orchestrator.start()` into `InputManager`.
- [x] 3.4 Keep existing SLS endpoint `redact` behavior unchanged so current endpoint-level redaction remains compatible.

## 4. Agent Type Coverage

- [x] 4.1 Ensure all inputs continue to set `agent.type` to the normalized `ClientType` value used as the `contentData` config key.
- [x] 4.2 Add or update tests proving different inputs with the same `agent.type` share the same upload policy.

## 5. Tests

- [x] 5.1 Add unit tests for `buildContentDataConfig()`: missing config defaults, per-agent overrides, string boolean parsing, invalid values, and unsupported fields ignored.
- [x] 5.2 Add unit tests for `applyContentDataPolicy()`: upload enabled preserves sensitive fields and upload disabled deletes them.
- [x] 5.3 Add unit tests confirming unsupported `maskEnabled` and `excludedWorkspace` values do not affect first-stage behavior.
- [x] 5.4 Add `InputManager` unit coverage showing policy-applied entries are dispatched to the flusher while non-sensitive metadata remains.
- [x] 5.5 Add regression coverage showing JSONL/HTTP/SLS all receive already policy-applied entries when routed through `MultiFlusher` or the orchestrator wiring.
- [x] 5.6 Add or update input-specific tests for Cursor and Qoder paths to verify policy lookup uses `agent.type` rather than input id.

## 6. Documentation & Validation

- [x] 6.1 Document the final `config.json` schema and defaults in the relevant quickstart or README section.
- [x] 6.2 Document that this stage only implements `uploadEnabled`; `maskEnabled` and `excludedWorkspace` are ignored until future work.
- [x] 6.3 Run the targeted Vitest suites for config loader, content-data policy, InputManager, and affected inputs.
- [x] 6.4 Run the full test suite if targeted tests pass.
