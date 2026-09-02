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

> **Experimental.** Multimodal config and event fields may change.

To store images from agent messages (inline base64, or local paths read then encoded) in object storage and keep only a `uri` on the event, set `multimodal.storage` in `config.json`: `type`, `target`, and `auth`. Whether upload runs is controlled per agent by `agents.<id>.multimodal.uploadMode`. Local file reads are limited to `agents.<id>.multimodal.allowedRootPaths` plus that agent's defaults. See [Multimodal Collection](multimodal.md).

`type` is one of `sls`, `delegatedOss`, or `oss`. This is separate from the log `sls` flusher. For `sls` and `delegatedOss` you do not set a storage prefix; Pilot uses `sls://{project}/{logstore}` from `project` and `logstore`.

`auth` is one complete ApiKey or access-key set. If `mode` is omitted, Pilot infers it from that set.

### `type: sls`

Writes with SLS PutObject. Event URI is `sls://{project}/{logstore}/{YYYYMMDD}/{sha256}.ext`.

```json
{
  "multimodal": {
    "storage": {
      "type": "sls",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal"
      },
      "auth": {
        "mode": "ak",
        "accessKeyId": "your-access-key-id",
        "accessKeySecret": "your-access-key-secret"
      }
    }
  }
}
```

ApiKey:

```json
{
  "multimodal": {
    "storage": {
      "type": "sls",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal"
      },
      "auth": {
        "mode": "apiKey",
        "apiKey": "your-sls-project-api-key"
      }
    }
  }
}
```

### `type: delegatedOss`

Asks SLS for a presigned URL, then writes to OSS. Event URI is `oss://{bucket}/{project}/{logstore}/{YYYYMMDD}/{sha256}.ext`. At startup Pilot confirms the current landing bucket with SLS. Optional `target.ossBucket` is checked against that bucket; a mismatch or a failed check leaves image upload off.

```json
{
  "multimodal": {
    "storage": {
      "type": "delegatedOss",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal",
        "ossBucket": "your-bucket"
      },
      "auth": {
        "mode": "apiKey",
        "apiKey": "your-sls-project-api-key"
      }
    }
  }
}
```

### `type: oss`

Writes directly to OSS. AK only.

```json
{
  "multimodal": {
    "storage": {
      "type": "oss",
      "target": {
        "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
        "storageBasePath": "oss://your-bucket/pilot-mm"
      },
      "auth": {
        "mode": "ak",
        "accessKeyId": "your-access-key-id",
        "accessKeySecret": "your-access-key-secret"
      }
    }
  }
}
```

| Setting | Description |
|---------|-------------|
| `multimodal.storage.type` | `sls`, `delegatedOss`, or `oss`. |
| `multimodal.storage.target.endpoint` | SLS or OSS regional endpoint (OSS accelerate endpoints are not supported). |
| `multimodal.storage.target.project` | SLS project. Required for `sls` and `delegatedOss`. |
| `multimodal.storage.target.logstore` | Logstore for multimodal objects; defaults to `logstore-multimodal`. |
| `multimodal.storage.target.ossBucket` | Optional. `delegatedOss` only; checked against the landing bucket. A mismatch leaves image upload off. |
| `multimodal.storage.target.storageBasePath` | Required for `oss`. Must start with `oss://`, for example `oss://bucket/prefix`. |
| `multimodal.storage.auth.mode` | Optional. `ak` or `apiKey`. If omitted, inferred from the configured credentials. `type=oss` requires `ak`. |
| `multimodal.storage.auth.accessKeyId` / `accessKeySecret` | Required when `mode=ak`. Optional `securityToken` for STS. |
| `multimodal.storage.auth.apiKey` | Required when `mode=apiKey`. Must not be set together with access keys. |

If `multimodal.storage` is missing or invalid, text collection continues and images are not converted to `uri`.

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
    "slsFailedDays": 7,
    "otlpFailedDays": 7,
    "metricAlarmDays": 7
  }
}
```

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` | Enables or disables retention cleanup. |
| `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` | Applies one retention period to all log categories. |
| `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` | Cleanup interval. |

`otlpFailedDays` controls managed files under `logs/otlp-failed`; `metricAlarmDays`
controls managed metrics, alarms, and updater-event files under `logs/metric_alarm`.
Both default to 7 days. These streams write one file per local calendar day; there
is no per-file size rotation. During scheduled cleanup, Pilot also tries to reduce
managed OTLP failure logs to 512 MiB and managed metric/alarm logs to 256 MiB by
deleting the oldest files while always retaining today and yesterday. These are
soft cleanup targets: current files can grow beyond them between cleanup runs.
Legacy undated files use their modification date for cleanup. When scheduled
retention is disabled, neither age nor size cleanup runs. `token-usage-state.json`
remains an overwrite state file and is excluded from this policy.

## Verify Changes

After editing configuration:

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

Use [Local JSONL Output](local-jsonl-output.md) as the quickest way to confirm that events are being collected.
