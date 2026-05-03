## 1. Baseline Implementation

- [x] 1.1 Add a Qoder SQLite helper query for maximum eligible `chat_message.rowid`.
- [x] 1.2 Override `QoderSqliteInput.onStart()` to baseline missing rowid state before the first collection cycle.
- [x] 1.3 Ensure startup baseline uses the same token eligibility filters as normal row collection.
- [x] 1.4 Ensure startup does not overwrite an existing persisted `lastRowId`.
- [x] 1.5 Keep startup fail-open if the SQLite database is temporarily unavailable.

## 2. Tests

- [x] 2.1 Add a test proving fresh state skips historical eligible rows.
- [x] 2.2 Add a test proving rows inserted after baseline are emitted.
- [x] 2.3 Add a test proving existing rowid state is preserved and rows after that cursor are collected.
- [x] 2.4 Add a test proving empty/invalid token rows do not cause historical emissions.

## 3. Verification

- [x] 3.1 Run Qoder SQLite unit tests.
- [x] 3.2 Run TypeScript typecheck and lints for edited files.
- [x] 3.3 Run the full test suite.
