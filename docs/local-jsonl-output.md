# Local JSONL Output

English | [简体中文](zh-CN/local-jsonl-output.md)

Local JSONL output writes normalized Pilot events to files on the same machine. It is enabled by default and is the easiest way to verify that collection is working before configuring a remote backend.

## Default Location

```text
~/.loongsuite-pilot/logs/output/
```

Files are named by agent and date:

```text
<agent-id>-YYYY-MM-DD.jsonl
<agent-id>.part-<id>-YYYY-MM-DD.jsonl
```

The first name is the active file; `part` files with unique IDs are closed size-based
segments. Their date suffix remains compatible with Dashboard and retention.
Each line is one normalized event.

JSONL preserves native JSON types: token counts remain numbers, flags remain
booleans, and message/tool payloads remain arrays or objects. String-only
backends such as wide-table log stores perform their own serialization at the
backend boundary.

## Enable Or Disable JSONL

```json
{
  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/output",
    "rotateDaily": true,
    "maxFileSizeMb": 100
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Enables or disables local JSONL output. |
| `outputDir` | Directory where output files are written. |
| `rotateDaily` | Rotates output by date. |
| `maxFileSizeMb` | Rotates before the next event would exceed this many MiB (default 100). Applies to Agent events and raw topics, including `rotateDaily=false`. Non-positive or non-finite values use the default. |

A JSON event is never split or truncated to meet a file limit. A single event
larger than the limit is written intact with a warning and rotated before the
next append. An existing active file larger than 3 GiB is deleted with a warning
before the next append. `rotateDaily=false` uses `all` in place of the date.

## Retention And Disk Protection

Local JSONL output follows the global retention policy in [Configuration Guide](configuration.md). By default, output logs are retained for 7 days.

Pilot also has fixed disk-protection cleanup for unusually large local output:

- Output files larger than 512 MiB can be removed after they are older than 2 days.
- If `logs/output` exceeds 2 GiB, periodic cleanup removes eligible old files and closed `part` segments, including today's closed segments, oldest first.
- Files strictly larger than **3 GiB** (`3 × 1024³` bytes) are reclaimed regardless of date or active name, including legacy files whose Agent has stopped writing.
- Smaller active and recent unsegmented files stay protected. Closed `all` segments participate using their modification date. Active files and single oversized events can keep the directory over target; this is periodic retention, not an instantaneous disk quota.
- The first full cleanup runs about 30 seconds after startup; full retention still defaults to every 6 hours. A separate 60-second pressure sweep covers `output`, `otlp-debug`, and `otlp-failed`; a shorter full interval already provides that coverage. Append, rotation, and emergency unlink share a process-local path lock, and cleanup rechecks file type and size.

`logs/otlp-debug` and `logs/otlp-failed` also rotate at 100 MiB. Debug mirrors use
the 2 GiB directory target. Failed evidence keeps its 512 MiB target, with today's
closed segments eligible under pressure; >3 GiB failed files are emergency
reclaimed too. Discarding failed evidence emits a warning and **does not mean the
backend accepted it or that replay is guaranteed**.

JSONL is a local mirror sent in parallel with remote outputs, not a per-file ACK
queue. Reclamation never removes Agent-owned transcripts, native telemetry, or
checkpoints. A custom `jsonl.outputDir` still rotates, but periodic reclamation
only manages the fixed `logs/output` and other managed directories under the
data directory; custom-directory quotas remain the caller's responsibility.

The Dashboard retains already-observed current-day totals by file identity,
including rotation, replacement, truncation, deletion, and restart with cache.
Replaced duplicate content is not deduplicated by event ID. A segment deleted
before its first scan, or loss of the metrics cache, can only be rebuilt from
files that still exist; removed data cannot be recovered from these mirrors.
The Dashboard skips output files larger than 3 GiB instead of opening giant files
that emergency retention will reclaim. Previously cached current-day totals stay
available; unread data is not invented.

Environment variables:

| Variable | Description |
|----------|-------------|
| `JSONL_ENABLED` | Enables or disables JSONL output. |
| `JSONL_OUTPUT_DIR` | Overrides the JSONL output directory. |

## Verify Local Output

Restart Pilot after editing config:

```bash
loongsuite-pilot restart
```

Inspect files:

```bash
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

If no output appears, make sure at least one supported agent is installed, enabled, and has produced new activity after Pilot started.

## Privacy Notes

JSONL is local, but it can still contain sensitive content. For safer output:

- Enable [Data Masking](masking.md).
