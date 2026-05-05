## 1. Fixtures and Test Harness

- [x] 1.1 Move or reference `raw-qoder-cli.jsonl` and `raw-qoder-ide.jsonl` as stable test fixtures.
- [x] 1.2 Add test helpers for collecting emitted entries from `QoderCliInput` using fixture rows.
- [x] 1.3 Add baseline tests proving the existing `qoder-cli` history path and listener id remain compatible.

## 2. Variant Detection

- [x] 2.1 Implement transcript row variant detection for CLI-like rows using `entrypoint`, `promptId`, `permissionMode`, or `userType`.
- [x] 2.2 Implement transcript row variant detection for IDE-like rows and default supported non-CLI rows to `qoder`.
- [x] 2.3 Add unit tests for `agent.type = qoder-cli` on CLI fixture rows and `agent.type = qoder` on IDE fixture rows.

## 3. Standard Event Mapping

- [x] 3.1 Replace legacy `buildAgentActivityEntry` options in `QoderCliInput` with standard dotted-field options.
- [x] 3.2 Map user text rows to `llm.request` with `message.role = user` and `input.messages_delta`.
- [x] 3.3 Map assistant text rows to `llm.response` with `message.role = assistant`, `output.messages`, model, and finish reason fields.
- [x] 3.4 Map assistant thinking rows to `llm.response` with reasoning-style `output.messages`.
- [x] 3.5 Map assistant `tool_use` blocks to `tool.call` with tool name, call id, and arguments.
- [x] 3.6 Map user `tool_result` blocks to `tool.result` with tool call id, result payload, status/error fields where available.
- [x] 3.7 Ignore `ai-title`, `last-prompt`, `session_meta`, `progress`, and unsupported row types.
- [x] 3.8 Preserve source diagnostics in `attributes`, including source channel, variant, raw row type, cwd, parent ids, and entrypoint when available.

## 4. Hook Processor Compatibility

- [x] 4.1 Confirm `qoder-loongsuite-pilot-hook.sh` remains fail-open and can still be invoked without relying on the argument as product identity.
- [x] 4.2 Keep `hook-processor.mjs` as a transcript forwarder and avoid semantic `AgentActivityEntry` mapping in the processor.
- [x] 4.3 Add or update integration coverage proving processor-forwarded history rows are consumable after mapper changes.

## 5. Regression and Output Verification

- [x] 5.1 Update `QoderCliInput` unit tests to assert standard dotted fields instead of legacy aliases.
- [x] 5.2 Update hook JSONL integration tests for schema-valid normalized entries and persisted offset behavior.
- [x] 5.3 Verify local JSONL serialization produces `qoder` and `qoder-cli` output files based on inferred `agent.type`.
- [x] 5.4 Run relevant unit/integration tests and TypeScript/lint checks.
