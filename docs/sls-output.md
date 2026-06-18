# SLS Output

English | [简体中文](zh-CN/sls-output.md)

SLS output sends normalized Pilot events to Alibaba Cloud Log Service. Use it when you want centralized search, dashboards, alerting, or long-term storage outside the developer machine.

## Enable SLS During Installation

```bash
bash /tmp/loongsuite-pilot-installer.sh install \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore"
```

For AK mode, also pass:

```bash
--sls-ak-id "your-access-key-id" \
--sls-ak-secret "your-access-key-secret"
```

## WebTracking Mode

Use WebTracking mode when the destination logstore accepts WebTracking writes.

```json
{
  "sls": {
    "enabled": true,
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "webtracking",
    "batchMaxSize": 20,
    "flushIntervalMs": 2000
  }
}
```

## AK Mode

Use AK mode when your SLS destination requires Access Key authentication.

```json
{
  "sls": {
    "enabled": true,
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "ak",
    "accessKeyId": "your-access-key-id",
    "accessKeySecret": "your-access-key-secret"
  }
}
```

## Multiple SLS Destinations

Use an array when the same events should be sent to multiple SLS destinations:

```json
{
  "sls": [
    {
      "name": "team-sls",
      "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
      "project": "team-project",
      "logstore": "agent-activity",
      "mode": "webtracking"
    },
    {
      "name": "secure-sls",
      "endpoint": "https://cn-shanghai.log.aliyuncs.com",
      "project": "secure-project",
      "logstore": "agent-activity",
      "mode": "ak",
      "accessKeyId": "your-access-key-id",
      "accessKeySecret": "your-access-key-secret"
    }
  ]
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_SLS_ENDPOINT` | SLS endpoint URL. |
| `LOONGSUITE_SLS_PROJECT` | SLS project. |
| `LOONGSUITE_SLS_LOGSTORE` | SLS logstore. |
| `LOONGSUITE_SLS_MODE` | `webtracking` or `ak`. |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | Access Key ID for AK mode. |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | Access Key Secret for AK mode. |
| `LOONGSUITE_PILOT_COLLECT_LOG` | Set `false` or `0` to disable SLS reporting. |

## Verify SLS Output

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

If SLS upload fails, failed batches are persisted locally:

```bash
ls ~/.loongsuite-pilot/sls-failed-logs/
```

Local JSONL output can help confirm whether collection itself is working before debugging SLS delivery:

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## Privacy Notes

SLS is a remote destination. Review [Agent Configuration](agents.md) for content capture controls and [Data Masking](masking.md) for secret masking before enabling SLS in sensitive environments.
