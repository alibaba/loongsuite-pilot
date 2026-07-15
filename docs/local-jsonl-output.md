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
```

Each line is one normalized event.

## Enable Or Disable JSONL

```json
{
  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/output",
    "rotateDaily": true
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Enables or disables local JSONL output. |
| `outputDir` | Directory where output files are written. |
| `rotateDaily` | Rotates output by date. |

## Retention And Disk Protection

Local JSONL output follows the global retention policy in [Configuration Guide](configuration.md). By default, output logs are retained for 7 days.

Pilot also has fixed disk-protection cleanup for unusually large local output:

- Output files larger than 512 MiB can be removed after they are older than 2 days.
- If `logs/output` exceeds 2 GiB, older dated output files are removed until the directory is back under the limit.
- Today's output file is never removed by retention cleanup. Size-pressure cleanup also keeps yesterday's output files.

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

JSONL is local, but it can still contain sensitive content if message content capture is enabled. For safer defaults:

- Disable full content capture with [Agent Configuration](agents.md).
- Enable [Data Masking](masking.md).
