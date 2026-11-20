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

The `install` command does not edit an existing `sls` array. It stops with an error; change its destinations and keys in `config.json` manually. The `upgrade` command preserves this file.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_SLS_ENDPOINT` | SLS endpoint URL. |
| `LOONGSUITE_SLS_PROJECT` | SLS project. |
| `LOONGSUITE_SLS_LOGSTORE` | SLS logstore. |
| `LOONGSUITE_SLS_MODE` | `webtracking`, `ak`, or `apiKey`. |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | Access Key ID for AK mode. |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | Access Key Secret for AK mode. |
| `LOONGSUITE_PILOT_COLLECT_LOG` | Set `false` or `0` to disable SLS reporting. |
| `LOONGSUITE_PILOT_HOST_IDENTITY_TAGS` | Set `false` or `0` to omit `__mac__` and `__sn__`. When unset, `hostIdentityTags` is used. |

API Key mode reads `apiKey` from `config.sls`; it has no environment variable override.

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

`FLUSH_SEND_ALARM` messages include the transport, normalized error category, structured error code, HTTP status, and actual attempt count. Network failures also include a one-line error summary from the error and its `cause` chain, with common credential patterns redacted and the summary limited to 512 UTF-8 bytes. HTTP response bodies are excluded. The `failure_class` field distinguishes these outcomes:

| Class | Handling |
|-------|----------|
| `transient` | Alarm after three consecutive cycles with only transient failures at this endpoint. A successful delivery resets the streak. |
| `quota` | Recognizes structured SLS write quota codes from the AK SDK and HTTP transports. The HTTP transports also recognize status 429. Emits `FLUSH_QUOTA_ALARM`. |
| `config` | Recognized terminal project or Logstore errors. Three consecutive cycles with only terminal configuration failures pause queued sends to this endpoint. |
| `payload` | The backend rejected an oversized request or Pilot detected an oversized WebTracking entry before sending it. A local rejection shows `attempts=0`. |

Transient and configuration alarms each have a one-hour cooldown per endpoint. After a configuration pause, one queued record probes the destination. A failed transport probe extends the pause up to ten minutes. The probe record stays queued when it can still be sent. A successful delivery reopens the queue. Pending records remain in memory. Queue pressure and normal shutdown can trigger a normal send attempt during the pause.

WebTracking measures the complete JSON request, including tags and separators. In the best-effort queue, Pilot checks the documented single-request size limit for standard Alibaba Cloud SLS endpoints. Oversized entries count as failed and appear in local diagnostics. Custom endpoints apply their own limits and report their own status. Codex submits records intact to the configured endpoint and still requires its acknowledgment.

Local JSONL output can help confirm whether collection itself is working before debugging SLS delivery:

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## Privacy Notes

SLS is a remote destination. Enable [Data Masking](masking.md) before using SLS in sensitive environments.

`__tag__:__mac__` and `__source__` come from the same NIC: at collector startup, the first non-loopback IPv4 in `os.networkInterfaces()`. A zero MAC omits the tag.

`__tag__:__sn__` comes from `hostSn` in `config.json`, written by the installer. The macOS installer reads `ioreg`, the Linux installer reads DMI files, and the Windows installer reads CIM. Those Linux files are usually root-only, so the field is left unset when they cannot be read. Placeholders and values longer than 128 bytes are omitted too. The tag is absent when `hostSn` is absent. Deleting it stops the tag. Running install again writes it back when the serial can still be read. A normal upgrade keeps the existing config and does not fill the field in. Set `hostIdentityTags` to `false` to omit both tags from the main collector and from Qoder. Masking does not remove them.
