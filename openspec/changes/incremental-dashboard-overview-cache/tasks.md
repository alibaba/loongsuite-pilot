## 1. Cache Model and Helpers

- [x] 1.1 Define the overview cache schema with version, per-file metadata, processed offset, and derived summaries.
- [x] 1.2 Add safe cache load and validation logic that ignores missing, malformed, or unsupported cache data.
- [x] 1.3 Add atomic cache persistence using write-to-temp plus rename under the LoongSuite Pilot data directory.
- [x] 1.4 Add helper logic to compare file metadata and decide whether to reuse, append, or rebuild a cached summary.
- [x] 1.5 Add internal per-refresh indexing budget defaults for cold cache and rebuild work, covering both byte and line limits without adding user-facing config.

## 2. Incremental JSONL Aggregation

- [x] 2.1 Refactor output record summarization into a reusable function that updates an existing file summary from parsed records.
- [x] 2.2 Replace tail-only reads with streaming or chunked reads from a requested byte offset.
- [x] 2.3 Process appended bytes from cached offset to current file size while preserving complete JSONL line boundaries.
- [x] 2.4 Rebuild a file summary from offset zero in bounded batches when the source file shrinks, is replaced, or has an invalid cache entry.
- [x] 2.5 Persist indexing progress when a refresh reaches the internal byte or line budget before the file is fully summarized.
- [x] 2.6 Replace large-file tail-read partial warnings with indexing progress metadata for output totals.

## 3. Dashboard Integration

- [x] 3.1 Wire the persisted cache into `createOverviewAggregator` without changing the `/api/overview` response shape.
- [x] 3.2 Add compatible overview metadata that lets the dashboard show when totals are still indexing or partial.
- [x] 3.3 Ensure same-day totals remain exact across dashboard refreshes and dashboard server restarts after indexing catches up.
- [x] 3.4 Keep raw prompt, output, tool result, and transcript fields out of persisted cache content.
- [x] 3.5 Prune or ignore cache entries for files that no longer match the requested local date.

## 4. Tests and Verification

- [x] 4.1 Add unit tests showing a cold large file processes only the injected test budget's first batch and reports partial/indexing metadata.
- [x] 4.2 Add unit tests showing later refreshes continue from the saved indexing offset until early token records are included.
- [x] 4.3 Add unit tests showing append-only refreshes increase fully indexed totals by processing only new records.
- [x] 4.4 Add unit tests for file shrink or invalid cache causing a bounded rebuild from source JSONL.
- [x] 4.5 Add unit tests showing persisted cache survives a new aggregator instance without tail-only undercounting after catch-up.
- [x] 4.6 Add regression coverage that persisted cache data does not contain sensitive message bodies.
- [x] 4.7 Run the monitor overview test suite and relevant lint/type checks.
