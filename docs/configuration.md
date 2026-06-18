# Configuration Guide

English | [简体中文](zh-CN/configuration.md)

LoongSuite Pilot can be configured through installer options, environment variables, and `config.json`. This page explains where configuration lives and points to task-specific setup guides.

## Configuration Loading Order

Pilot resolves configuration in this order:

1. Environment variables.
2. Config file, defaulting to `~/.loongsuite-pilot/config.json`.
3. Built-in defaults.

Set `AGENT_DATA_COLLECTION_CONFIG` to use a different config file path.

## Common Global Settings

```jsonc
{
  "enabled": true,
  "dataDir": "~/.loongsuite-pilot",
  "userId": "your-user-id",
  "collectLog": true,
  "collectTrace": true,
  "serviceNamePrefix": "loongsuite-pilot"
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Master switch for the collector. |
| `dataDir` | Local runtime and data directory. |
| `userId` | User identity written to emitted events. Defaults to the machine hostname. |
| `collectLog` | Enables SLS log reporting. JSONL and HTTP remain controlled by their own `enabled` flags. |
| `collectTrace` | Enables OTLP trace export when a trace destination is configured. |
| `serviceNamePrefix` | Service name prefix used by reporting backends. |

Equivalent environment variables:

| Variable | Description |
|----------|-------------|
| `AGENT_DATA_COLLECTION_CONFIG` | Custom config file path. |
| `LOONGSUITE_PILOT_ENABLED` | Set `false` or `0` to disable the collector. |
| `LOONGSUITE_PILOT_DATA_DIR` | Override the data directory. |
| `LOONGSUITE_PILOT_USER_ID` | Override `userId`. |
| `LOONGSUITE_PILOT_COLLECT_LOG` | Set `false` or `0` to disable SLS log reporting. |
| `LOONGSUITE_PILOT_COLLECT_TRACE` | Set `false` or `0` to disable trace reporting. |
| `LOONGSUITE_PILOT_SERVICE_NAME_PREFIX` | Override `serviceNamePrefix`. |
| `LOG_LEVEL` | Runtime log level: `debug`, `info`, `warn`, `error`, or `silent`. |

## Configuration Topics

| Task | Guide |
|------|-------|
| Choose which agents to collect and whether message content is captured | [Agent Configuration](agents.md) |
| Write normalized events to local JSONL files | [Local JSONL Output](local-jsonl-output.md) |
| Report logs to Alibaba Cloud SLS | [SLS Output](sls-output.md) |
| Report GenAI activity as OTLP traces | [Trace Output](trace-output.md) |
| POST events to a custom HTTP endpoint | [HTTP Output](http-output.md) |
| Mask API keys, access keys, private keys, and database URLs | [Data Masking](masking.md) |

## Retention

Pilot can clean up local runtime logs on a schedule.

```json
{
  "retention": {
    "enabled": true,
    "hookHistoryDays": 7,
    "hookErrorDays": 7,
    "hookDebugDays": 7,
    "outputDays": 7,
    "slsFailedDays": 7
  }
}
```

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` | Enables or disables retention cleanup. |
| `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` | Applies one retention period to all log categories. |
| `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` | Cleanup interval. |

## Verify Changes

After editing configuration:

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

Use [Local JSONL Output](local-jsonl-output.md) as the quickest way to confirm that events are being collected.
