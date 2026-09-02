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

For API Key mode, pass:

```bash
--sls-api-key "your-api-key"
```

Do not pass `--sls-api-key` together with `--sls-ak-id` or `--sls-ak-secret`.

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

## API Key Mode

Use API Key mode when your SLS destination accepts collection API Key authentication. Pilot writes through the direct SLS protobuf API:

- `POST /logstores/{logstore}/shards/lb`
- `Authorization: Bearer <apiKey>`
- `Content-Type: application/x-protobuf`
- `Content-MD5` with the protobuf body MD5 in uppercase hex

This mode is not WebTracking query-parameter upload.

```json
{
  "sls": {
    "enabled": true,
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "apiKey",
    "apiKey": "your-api-key"
  }
}
```

Do not configure `apiKey` and `accessKeyId` / `accessKeySecret` on the same SLS destination.

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
      "name": "api-key-sls",
      "endpoint": "https://cn-beijing.log.aliyuncs.com",
      "project": "api-key-project",
      "logstore": "agent-activity",
      "mode": "apiKey",
      "apiKey": "your-api-key"
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
| `LOONGSUITE_SLS_MODE` | `webtracking`, `ak`, or `apiKey`. |
| `LOONGSUITE_SLS_API_KEY` | API Key for API Key mode. |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | Access Key ID for AK mode. |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | Access Key Secret for AK mode. |
| `LOONGSUITE_PILOT_COLLECT_LOG` | Set `false` or `0` to disable SLS reporting. |

## Verify SLS Output

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

If an SLS upload still fails after retries, Pilot persists bounded diagnostic metadata locally:

```bash
ls ~/.loongsuite-pilot/logs/sls-failed-logs/
```

These JSONL records contain the endpoint, error summary, batch count, and batch byte estimate. They do **not** contain the failed batch payload, message content, request headers, or credentials, so they cannot be used to replay failed uploads. Files rotate by local date and at 10 MiB; the directory is limited to 50 MiB and also follows `retention.slsFailedDays` (7 days by default).

### Retry and failure diagnostics

This change does not alter the retry policy. HTTP 403 remains permanent, including structured `ShardWriteQuotaExceed` responses, while existing retryable statuses and network failures keep their current bounded attempts and backoff.

Final failures continue to use the existing alarm types. Their message contains only a normalized category, safe code or HTTP status, and the actual attempt count, for example `SLS webtracking send failed [category=dns code=ENOTFOUND attempts=3]` or `SLS apiKey send failed [category=http code=ShardWriteQuotaExceed status=403 attempts=1]`. Raw response bodies, URLs, proxy or certificate details, headers, credentials, and payloads are not copied into remote alarm messages. The local failure record reuses its existing `error_code` and `http_status` fields, including a bounded nested `Error.cause.code`; no new remote field or index is added.

Local JSONL output can help confirm whether collection itself is working before debugging SLS delivery:

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## Privacy Notes

SLS is a remote destination. Review [Agent Configuration](agents.md) for content capture controls and [Data Masking](masking.md) for secret masking before enabling SLS in sensitive environments.
