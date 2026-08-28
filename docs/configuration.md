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
  "dashboard": { "port": 8765 },
  "serviceName": "my-agent-service"
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Master switch for the collector. |
| `dataDir` | Local runtime and data directory. |
| `userId` | User identity written to emitted events. Defaults to the machine hostname. |
| `collectLog` | Enables SLS log reporting. JSONL and HTTP remain controlled by their own `enabled` flags. |
| `collectTrace` | Enables OTLP trace export when a trace destination is configured. |
| `dashboard.port` | Loopback dashboard port. Must be an integer from 1 through 65535; invalid values fall back to `8765`. |
| `serviceName` | Exact service name shared by every agent and reporting backend. It takes precedence over all service-name prefixes. |
| `serviceNamePrefix` | Legacy service-name base. When `serviceName` is unset, Pilot reports each agent as `<serviceNamePrefix>-<agentType>`. |

Equivalent environment variables:

| Variable | Description |
|----------|-------------|
| `AGENT_DATA_COLLECTION_CONFIG` | Custom config file path. |
| `LOONGSUITE_PILOT_ENABLED` | Set `false` or `0` to disable the collector. |
| `LOONGSUITE_PILOT_DATA_DIR` | Override the data directory. |
| `LOONGSUITE_PILOT_USER_ID` | Override `userId`. |
| `LOONGSUITE_PILOT_COLLECT_LOG` | Set `false` or `0` to disable SLS log reporting. |
| `LOONGSUITE_PILOT_COLLECT_TRACE` | Set `false` or `0` to disable trace reporting. |
| `LOONGSUITE_PILOT_SERVICE_NAME` | Override `serviceName` with one exact name for all agents and backends. |
| `LOONGSUITE_PILOT_SERVICE_NAME_PREFIX` | Override `serviceNamePrefix`. |
| `LOG_LEVEL` | Runtime log level: `debug`, `info`, `warn`, `error`, or `silent`. |

## SLS Secret Configuration

SLS destinations may use WebTracking, AK/SK, or API Key mode. API Key mode stores the key in local `config.json`, so prefer filesystem permissions and avoid sharing the file.

```json
{
  "sls": {
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "apiKey",
    "apiKey": "your-api-key"
  }
}
```

Do not put `apiKey` together with `accessKeyId` / `accessKeySecret` on the same SLS destination. Use [SLS Output](sls-output.md) for full mode examples.

## Multimodal Object Storage

When Pilot should convert images in agent messages (inline base64, or local paths read and encoded by each agent extractor) into object-storage `uri` parts, configure global multimodal infrastructure in `config.json`. Whether upload actually runs is controlled per agent by `agents.<id>.multimodal.uploadMode`; local `pathToUri` reads are limited to `agents.<id>.multimodal.allowedRootPaths` plus agent defaults. See [Multimodal Collection](multimodal.md).

### OSS

```json
{
  "multimodal": {
    "uploader": "oss",
    "storageBasePath": "oss://your-bucket/pilot-mm",
    "oss": {
      "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
      "accessKeyId": "your-access-key-id",
      "accessKeySecret": "your-access-key-secret"
    }
  }
}
```

| Setting | Description |
|---------|-------------|
| `multimodal.uploader` | `oss` or `sls`. |
| `multimodal.storageBasePath` | Required for OSS; must start with `oss://`, for example `oss://bucket/prefix`. |
| `multimodal.oss.endpoint` | Standard regional endpoint (accelerate endpoints are not supported). |
| `multimodal.oss.accessKeyId` / `accessKeySecret` | Credentials; optional `securityToken` for STS. |

### SLS PutObject

SLS multimodal uses a dedicated PutObject path, separate from the log `sls` flusher block. `storageBasePath` is derived as `sls://{project}/{logstore}` and does not need to be set by hand.

```json
{
  "multimodal": {
    "uploader": "sls",
    "sls": {
      "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
      "project": "your-project",
      "logstore": "logstore-multimodal",
      "accessKeyId": "your-access-key-id",
      "accessKeySecret": "your-access-key-secret"
    }
  }
}
```

| Setting | Description |
|---------|-------------|
| `multimodal.sls.endpoint` | SLS endpoint. |
| `multimodal.sls.project` | SLS project. |
| `multimodal.sls.logstore` | Logstore used for multimodal objects; defaults to `logstore-multimodal`. |
| `multimodal.sls.accessKeyId` / `accessKeySecret` | Credentials; optional `securityToken` for STS. |

If global multimodal config is missing or invalid, Pilot fails open: text collection continues, and blob→uri conversion is skipped.

## Configuration Topics

| Task | Guide |
|------|-------|
| Choose which agents to collect and whether message content / multimodal capture runs | [Agent Configuration](agents.md), [Multimodal Collection](multimodal.md) |
| Write normalized events to local JSONL files | [Local JSONL Output](local-jsonl-output.md) |
| Report logs to Alibaba Cloud SLS | [SLS Output](sls-output.md) |
| Report GenAI activity as OTLP traces | [Trace Output](trace-output.md) |
| POST events to a custom HTTP endpoint | [HTTP Output](http-output.md) |
| Mask API keys, access keys, private keys, database URLs, and personal sensitive data | [Data Masking](masking.md) |

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
