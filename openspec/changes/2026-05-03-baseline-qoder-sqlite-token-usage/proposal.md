## Why

`QoderSqliteInput` currently starts from rowid `0` when its local state is missing. If LoongSuite Pilot is uninstalled by deleting `~/.loongsuite-pilot` and then reinstalled, the collector can replay all historical Qoder SQLite token usage rows and re-upload old sessions to local JSONL/SLS.

## What Changes

- Add startup baseline behavior for Qoder SQLite token usage polling.
- When the `qoder-sqlite` input has no persisted rowid state, initialize its cursor to the current maximum eligible `chat_message.rowid` without emitting historical entries.
- Preserve normal incremental behavior when state already exists: continue reading only `rowid > lastRowId`.
- Preserve runtime behavior for new rows after startup: newly inserted eligible token usage rows are emitted.
- Keep token usage mapping and output flusher behavior unchanged.

## Capabilities

### New Capabilities
- `qoder-sqlite-startup-baseline`: Prevent historical Qoder SQLite token usage replay after LoongSuite Pilot state loss or reinstall by baselining the rowid cursor on first start.

### Modified Capabilities

## Impact

- Updates `QoderSqliteInput` lifecycle or query helpers to baseline rowid state before the first collection cycle.
- Adds tests for first start with existing historical rows, subsequent new rows, and restart with existing state.
- No schema, dependency, or flusher changes are expected.
