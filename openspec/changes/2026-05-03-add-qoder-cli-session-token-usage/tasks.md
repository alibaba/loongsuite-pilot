## 1. Input Source Setup

- [x] 1.1 Add a `qoder-cli-session` input module that extends `BaseSessionInput`.
- [x] 1.2 Resolve the default session root to `~/.qoder/logs/sessions` and expose `checkAvailability()` / `getWatchPaths()`.
- [x] 1.3 Implement file discovery for `**/segments/*.jsonl` while ignoring other JSONL files under the session root.

## 2. Startup State Behavior

- [x] 2.1 Add startup baseline logic so segment files present at input start are advanced to their current byte offsets without emitting entries.
- [x] 2.2 Ensure segment files first discovered after startup are processed from offset 0.
- [x] 2.3 Preserve existing per-file offset and inode rotation behavior from `BaseSessionInput`.

## 3. Token Usage Mapping

- [x] 3.1 Implement `processSessionLine()` to ignore unsupported event types and process only `model.response.completed`.
- [x] 3.2 Map `model.response.completed` records to `AgentActivityEntry` with `agent.type = qoder-cli`.
- [x] 3.3 Derive `session.id` from the directory immediately above `segments`.
- [x] 3.4 Map request, response, turn, step, model, stop reason, and token usage fields into standard entry fields.
- [x] 3.5 Generate deterministic `event.id` values from stable segment row fields.
- [x] 3.6 Preserve useful source metadata in `attributes`, including Qoder event type, sequence number, request index, segment file, and cwd key.

## 4. Registration and Configuration

- [x] 4.1 Register the new input in the orchestrator and discovery entries.
- [x] 4.2 Add a default listener config for the new input with the existing Qoder poll interval behavior where appropriate.
- [x] 4.3 Export the new input from the public entrypoint if consistent with existing input exports.

## 5. Tests and Verification

- [x] 5.1 Add unit tests for segment discovery across multiple cwd/session directories.
- [x] 5.2 Add unit tests for ignoring non-segment JSONL files and unsupported Qoder event types.
- [x] 5.3 Add unit tests for startup baselining and runtime-created segment files.
- [x] 5.4 Add unit tests for token usage mapping, path-derived session ids, and deterministic event ids.
- [x] 5.5 Update orchestrator/config-loader tests for registration and listener defaults.
- [x] 5.6 Run the relevant unit/integration tests and TypeScript/lint checks.
