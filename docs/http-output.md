# HTTP Output

English | [简体中文](zh-CN/http-output.md)

HTTP output POSTs normalized Pilot events to a custom endpoint. Use it when you already have an ingestion gateway or want to forward Pilot data into your own service.

## Configure HTTP Output

```json
{
  "http": {
    "enabled": true,
    "url": "https://your-endpoint.example.com/events",
    "headers": {
      "Authorization": "Bearer token"
    },
    "batchMaxSize": 20,
    "flushIntervalMs": 5000,
    "requestTimeoutMs": 10000
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Enables or disables HTTP output. |
| `url` | Endpoint that receives POST requests. |
| `headers` | Optional request headers. |
| `batchMaxSize` | Maximum events per request batch. |
| `flushIntervalMs` | Maximum wait time before a batch is flushed. |
| `requestTimeoutMs` | Request timeout in milliseconds. |

Environment variables:

| Variable | Description |
|----------|-------------|
| `HTTP_REPORT_URL` | HTTP endpoint URL. Setting this enables HTTP output when non-empty. |
| `HTTP_REPORT_HEADERS` | JSON string for request headers. |

## Verify HTTP Output

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

Keep local JSONL enabled while first integrating HTTP output. It lets you confirm that events are being collected even if the custom endpoint rejects requests.

## Privacy Notes

HTTP output is a remote destination. Review [Agent Configuration](agents.md) for content capture controls and [Data Masking](masking.md) for secret masking before enabling it in sensitive environments.
