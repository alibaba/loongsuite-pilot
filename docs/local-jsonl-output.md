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
next append. Existing oversized active files are also rotated on their next
write. `rotateDaily=false` uses `all` in place of the date.

## Retention And Disk Protection

Local JSONL output follows the global retention policy in [Configuration Guide](configuration.md). By default, output logs are retained for 7 days.

Pilot also has fixed disk-protection cleanup for unusually large local output:

- Output files larger than 512 MiB can be removed after they are older than 2 days.
- If `logs/output` exceeds 2 GiB, periodic cleanup removes eligible old files and closed `part` segments, including today's closed segments, oldest first.
- Today's and yesterday's unsegmented/active files stay protected. Closed `all` segments also participate in cleanup using their modification date. Active files and single oversized events can keep the directory over the target; this is a periodic retention target, not an instantaneous disk quota.

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
