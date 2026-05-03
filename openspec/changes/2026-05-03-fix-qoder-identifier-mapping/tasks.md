## 1. Qoder CLI Session Segment Mapping

- [x] 1.1 Update `QoderCliSessionInput` to preserve segment `request_id` only in attributes.
- [x] 1.2 Remove `request.id` emission from Qoder CLI session segment token usage entries.
- [x] 1.3 Remove `turn.id` emission from Qoder CLI session segment token usage entries.
- [x] 1.4 Remove `step.id` emission from Qoder CLI session segment token usage entries.
- [x] 1.5 Preserve raw `request_id`, `turn_id`, and `loop_id` in attributes when useful for diagnostics.

## 2. Qoder Transcript Hook Mapping

- [x] 2.1 Update `QoderCliInput` assistant response mapping to emit `response.id` from transcript `message.id`.
- [x] 2.2 Ensure Qoder IDE transcript rows do not emit `request.id`.
- [x] 2.3 Ensure Qoder CLI transcript rows do not synthesize `request.id` from prompt, parent, message, or response identifiers.
- [x] 2.4 Keep `message_id` in attributes for diagnostic compatibility.

## 3. Tests and Verification

- [x] 3.1 Update Qoder CLI session input tests for absent `response.id`, absent `request.id`, absent `turn.id`, and absent `step.id`.
- [x] 3.2 Update Qoder transcript hook tests for assistant `response.id` from `message.id`.
- [x] 3.3 Add assertions that Qoder IDE transcript entries omit `request.id`.
- [x] 3.4 Update Qoder SQLite input mapping/tests so `chat_message.request_id` remains attributes-only.
- [x] 3.5 Run Qoder-focused tests, TypeScript typecheck, lints, and the full test suite.
