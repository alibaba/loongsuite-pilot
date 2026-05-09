## Why

The dashboard currently computes "today" totals by reading only the tail of large JSONL output files, which keeps refreshes cheap but can make `Tokens Today` and event counts undercount or decrease as the tail window moves. Users need the overview to remain accurate for normal append-only output files without making each dashboard refresh scan the full day's logs.

## What Changes

- Replace tail-only dashboard aggregation for output JSONL files with an incremental, offset-based summary cache.
- Track per-file metadata such as size, mtime, read offset, and accumulated per-agent totals so refreshes only process newly appended lines.
- Bound cold-cache indexing work per refresh by processing only an internal budget of bytes or lines, then continue indexing on later refreshes.
- Rebuild a file summary when a file shrinks, changes identity, or has an invalid cache entry.
- Persist overview aggregation cache under the LoongSuite Pilot data directory so dashboard restarts can resume efficiently.
- Keep the dashboard read-only with respect to source JSONL files and avoid changing the JSONL flusher hot path.

## Capabilities

### New Capabilities
- `agent-overview-dashboard`: User-facing dashboard overview totals and health summaries derived from local runtime output files.

### Modified Capabilities

## Impact

- Affected code: `scripts/lib/agent-overview.mjs`, monitor server tests, and overview dashboard tests.
- Affected data: adds a small local cache file or directory under `~/.loongsuite-pilot` for dashboard aggregation metadata.
- APIs: `GET /api/overview` response shape remains compatible with additive cache/indexing metadata; totals become accurate for append-only files once indexing catches up beyond the current tail-read limit.
- Dependencies: no new runtime dependency expected; implementation should use Node.js standard filesystem APIs.
