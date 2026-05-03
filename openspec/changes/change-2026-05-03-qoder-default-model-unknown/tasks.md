## 1. Qoder Transcript Mapping

- [x] 1.1 Update `QoderCliInput` so entries inferred as `agent.type = qoder` use `request.model = unknown`.
- [x] 1.2 Update `QoderCliInput` so entries inferred as `agent.type = qoder` use `response.model = unknown`.
- [x] 1.3 Ensure `qoder-cli` transcript rows keep real model values and are not overwritten with `unknown`.
- [x] 1.4 Ensure `qoder-cli` transcript rows missing model values use `request.model = unknown` and `response.model = unknown`.

## 2. Qoder SQLite Mapping

- [x] 2.1 Update `QoderSqliteInput` to emit `request.model = unknown`.
- [x] 2.2 Update `QoderSqliteInput` to emit `response.model = unknown`.
- [x] 2.3 Keep existing token usage, identifiers, and attributes behavior unchanged.

## 3. Qoder CLI Session and Cursor Mapping

- [x] 3.1 Ensure `QoderCliSessionInput` keeps real model values when available.
- [x] 3.2 Ensure `QoderCliSessionInput` uses `unknown` when model values are missing.
- [x] 3.3 Ensure `CursorHookInput` keeps real model values when available.
- [x] 3.4 Ensure `CursorHookInput` uses `unknown` when model values are missing.

## 4. Tests and Verification

- [x] 4.1 Add/update Qoder transcript hook tests for model defaults.
- [x] 4.2 Add/update Qoder SQLite tests for `request.model` and `response.model = unknown`.
- [x] 4.3 Add/update tests proving `qoder-cli` real model values remain unchanged.
- [x] 4.4 Add/update Cursor tests for model defaults.
- [x] 4.5 Run Qoder/Cursor-focused tests.
- [x] 4.6 Run TypeScript typecheck and lints.
- [x] 4.7 Run the full test suite.
