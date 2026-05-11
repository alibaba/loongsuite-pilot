## Context

The monitor dashboard builds `GET /api/overview` from local service logs, failed-upload logs, and normalized output JSONL files under `~/.loongsuite-pilot/logs/output`. Today's output files are selected by filename suffix `-YYYY-MM-DD.jsonl`, then summarized into totals and per-agent cards.

The current output summarizer bounds work by reading only the last 2 MB of each JSONL file. That protects dashboard refresh latency, but it makes totals approximate for large files. As the file grows, the read window moves forward and older records can disappear from the calculation, so `Tokens Today` can decrease even though the source file is append-only.

The JSONL flusher already writes one line at a time to stable daily files. This change should keep that hot path unchanged and make the dashboard aggregator responsible for efficient summaries. For users upgrading with large existing files, cold-cache indexing must be bounded so one dashboard request does not scan the entire historical file.

## Goals / Non-Goals

**Goals:**
- Provide exact `Events Today` and `Tokens Today` totals for normal append-only daily output files.
- Keep dashboard refresh cost bounded during cold-cache indexing and proportional to newly appended bytes after indexing catches up.
- Persist enough cache metadata for dashboard process restarts to avoid returning to tail-only approximation.
- Detect truncation, replacement, or invalid cache state and rebuild safely.
- Preserve the current `/api/overview` response shape for existing dashboard clients, with additive indexing metadata allowed.

**Non-Goals:**
- Add size-based rotation to `JsonlFlusher`.
- Change normalized JSONL record schema or token extraction semantics.
- Guarantee exact totals while another process rewrites historical lines in place without changing file size.
- Track upload-success counters or SLS delivery state beyond existing dashboard behavior.

## Decisions

1. Use an offset-based per-file summary cache in the overview aggregator.

   Each cache entry will store file identity metadata, current byte size, last processed offset, and accumulated summary data such as total records, total tokens, per-agent totals, event type counts, method totals, and last activity. On refresh, the aggregator stats the file and reads only bytes from the cached offset to the current size. This keeps steady-state work small while preserving exact totals for append-only files.

   Alternative considered: increase the tail window. This delays the problem but does not make totals exact and still allows decreases once files exceed the new limit.

2. Bound cold-cache and rebuild work per refresh.

   When a file has no valid cache entry, or when a rebuild is required, the aggregator will start from offset zero but process at most an internal implementation budget per overview request, such as module-level defaults named `maxIndexBytesPerRefresh` and/or `maxIndexLinesPerRefresh`. These limits are not user-facing `config.json` settings; tests may inject smaller values through aggregator options. The cache entry will store `indexedThroughOffset`, `targetSizeAtIndexStart`, and an `indexing` state. Each later refresh continues from the saved offset until the file is fully indexed, then switches to the normal append-only path.

   While any matching file is still indexing, the overview response should mark totals as partial with additive metadata such as `cache.indexing: true`, per-file progress, or a warning. The dashboard can display "indexing local logs" instead of implying the totals are final. Once indexing reaches the known file size and processes any newly appended bytes, totals become exact.

   Alternative considered: perform the full cold scan in one streaming pass. It is memory-safe but can make the first dashboard request slow for users upgrading with large local logs.

3. Rebuild from the start when cache validity is uncertain.

   The aggregator will discard and rebuild a file summary when the file size is smaller than the cached offset, required cache fields are missing, the cache version is unsupported, or file identity metadata indicates replacement. If a platform cannot provide stable identity metadata, size shrink and parse-safe offset handling are still sufficient for the common append-only path.

   Alternative considered: trust `mtime` and size only. That is simpler but can reuse stale summaries if a file is replaced with another file of similar size.

4. Persist dashboard cache under the data directory, separate from source output files.

   Store overview cache data under a dashboard-owned path such as `~/.loongsuite-pilot/cache/agent-overview/` or `~/.loongsuite-pilot/logs/output/.overview-cache/`. The cache is derived data and can be deleted at any time; deletion only causes the next overview refresh to rebuild summaries.

   Alternative considered: write sidecar files next to every JSONL file. That makes locality obvious but clutters the output directory and increases the chance that external tools mistake cache artifacts for source logs.

5. Preserve bounded memory with streaming or chunked reads.

   Initial indexing, rebuilds, and incremental reads should process complete JSONL lines without loading unbounded files into memory. The implementation should carry an incomplete trailing line between reads when necessary, or choose stream processing that naturally emits full lines. The budget should stop only on a complete line boundary, or persist an incomplete-line buffer in the cache entry.

   Alternative considered: use `readFile` for the first full scan. It is easier but recreates the original scalability problem on large files.

6. Keep raw message fields out of cache.

   The cache should store only derived counts, timestamps, event names, agent IDs, method IDs, token sums, and file metadata. It must not persist prompt, output, tool result, or transcript bodies.

## Risks / Trade-offs

- Cache corruption or version mismatch -> Ignore the cache entry and rebuild from source JSONL.
- Cold-cache totals for a very large existing file are partial until indexing catches up -> Expose indexing metadata and continue indexing on each refresh without blocking one request on the full file.
- Indexing from the beginning means early refreshes may undercount current-day totals -> Label totals as partial until all matching files are fully indexed.
- In-place historical edits with unchanged size can leave stale derived totals -> Treat this as outside normal operation; document that exactness is guaranteed for append-only files and safe rebuild cases.
- Multiple dashboard server processes may update the same cache -> Use atomic write-by-rename for cache persistence so readers never observe partial JSON.
- Cache files consume disk space -> Store compact derived summaries and allow safe deletion; optionally prune cache entries for dates or files no longer present.
