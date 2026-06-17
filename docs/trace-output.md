# Trace Output

English | [简体中文](zh-CN/trace-output.md)

Trace output exports GenAI activity as OpenTelemetry traces. Use it when you want to analyze sessions, turns, model calls, and tool calls in a trace or APM backend.

Trace output is separate from log output. SLS, JSONL, and HTTP receive event records; OTLP trace output converts those records into trace spans.

## Generic OTLP Trace Output

```json
{
  "collectTrace": true,
  "otlpTrace": {
    "endpoint": "https://otel-collector.example.com/v1/traces",
    "headers": {
      "Authorization": "Bearer token"
    },
    "serviceName": "loongsuite-pilot",
    "resourceAttributes": {
      "deployment.environment": "prod"
    },
    "captureMessageContent": false,
    "debug": false,
    "turnIdleTimeoutMs": 0
  }
}
```

| Setting | Description |
|---------|-------------|
| `collectTrace` | Master switch for trace export. |
| `otlpTrace.endpoint` | OTLP HTTP trace endpoint. |
| `otlpTrace.headers` | Headers sent to the OTLP endpoint. |
| `otlpTrace.serviceName` | Service name attached to exported spans. |
| `otlpTrace.resourceAttributes` | Extra OpenTelemetry resource attributes. |
| `otlpTrace.captureMessageContent` | Whether trace export may include message content. |
| `otlpTrace.debug` | Enables local debug output for trace conversion. |
| `otlpTrace.turnIdleTimeoutMs` | Optional idle timeout for grouping turn-level trace data. |

Environment variables:

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_COLLECT_TRACE` | Set `false` or `0` to disable trace export. |
| `LOONGSUITE_PILOT_OTLP_ENDPOINT` | OTLP trace endpoint. |
| `LOONGSUITE_PILOT_OTLP_HEADERS` | JSON string for OTLP headers. |

## ARMS/CMS-Compatible Trace Output

Pilot also supports a CMS-style trace configuration:

```json
{
  "collectTrace": true,
  "cms": {
    "licenseKey": "your-license-key",
    "endpoint": "https://your-arms-endpoint/v1/traces",
    "workspace": "your-workspace",
    "debug": false
  }
}
```

Environment variables:

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_CMS_LICENSE_KEY` | CMS or ARMS license key. |
| `LOONGSUITE_PILOT_CMS_ENDPOINT` | CMS or ARMS trace endpoint. |
| `LOONGSUITE_PILOT_CMS_WORKSPACE` | Workspace header value. |

## Content Capture In Traces

Trace spans can carry sensitive content if message capture is enabled. For sensitive or team-managed setups, prefer:

```json
{
  "otlpTrace": {
    "captureMessageContent": false
  },
  "agents": {
    "claude-code": { "captureMessageContent": false },
    "codex": { "captureMessageContent": false },
    "cursor": { "captureMessageContent": false }
  }
}
```

Also enable [Data Masking](masking.md) when trace data may include secrets.

## Verify Trace Output

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

If `otlpTrace.debug` or `cms.debug` is enabled, debug output is written under:

```text
~/.loongsuite-pilot/logs/otlp-debug/
```

Failed trace export data may be persisted under:

```text
~/.loongsuite-pilot/logs/otlp-failed/
```
