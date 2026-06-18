# Trace Output

English | [简体中文](zh-CN/trace-output.md)

Trace output exports GenAI activity as OpenTelemetry traces. Use it when you want to analyze sessions, turns, model calls, and tool calls in a trace or APM backend.

Trace output is separate from log output. SLS, JSONL, and HTTP receive event records; OTLP trace output converts those records into trace spans.

## Generic OTLP Trace Output

```json
{
  "collectTrace": true,
  "otlpTrace": {
    "endpoint": "https://otel-collector.example.com",
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
| `otlpTrace.endpoint` | OTLP HTTP base URL. Pilot auto-appends `/v1/traces` if the path does not already end with it. |
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

## Backend Examples

### Jaeger

[Jaeger](https://www.jaegertracing.io/) natively supports OTLP ingestion. Use the v2 image for a quick local setup:

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.19.0
```

> **Note:** Pilot uses HTTP/protobuf for OTLP export (port 4318). Port 4317 (gRPC) is exposed for other tools that may need it.

Configure Pilot:

```json
{
  "collectTrace": true,
  "otlpTrace": {
    "endpoint": "http://localhost:4318",
    "serviceName": "loongsuite-pilot"
  }
}
```

Or via environment variables:

```bash
export LOONGSUITE_PILOT_OTLP_ENDPOINT=http://localhost:4318
export LOONGSUITE_PILOT_COLLECT_TRACE=true
```

Open [http://localhost:16686](http://localhost:16686) and select the service name to view traces.

### Langfuse

[Langfuse](https://langfuse.com/) is an LLM observability platform with native OTLP ingestion. It provides LLM-specific views including cost tracking, token usage, and prompt/completion content.

**1. Start Langfuse (self-hosted):**

```bash
mkdir -p ~/langfuse && cd ~/langfuse
curl -sLO https://raw.githubusercontent.com/langfuse/langfuse/v3.187.0/docker-compose.yml

# Generate random secrets (do NOT use placeholder values in production)
umask 077
cat > .env << EOF
NEXTAUTH_SECRET=$(openssl rand -base64 32)
SALT=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
LANGFUSE_INIT_ORG_NAME=MyOrg
LANGFUSE_INIT_PROJECT_NAME=loongsuite-pilot
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-my-public-key
LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-my-secret-key
LANGFUSE_INIT_USER_EMAIL=admin@example.com
LANGFUSE_INIT_USER_NAME=admin
LANGFUSE_INIT_USER_PASSWORD=$(openssl rand -base64 16)
TELEMETRY_ENABLED=false
EOF

docker compose up -d
```

> **Security:** The `.env` file above generates cryptographically random values for secrets. The `umask 077` ensures the file is only readable by the current user. Review the generated `.env` before starting the services, and note the generated password for your first login.

**2. Configure Pilot:**

Langfuse OTLP endpoint requires Basic authentication with `Base64(public_key:secret_key)`. Use environment variables to avoid storing credentials in config files:

```bash
LANGFUSE_AUTH=$(printf '%s' 'pk-lf-my-public-key:sk-lf-my-secret-key' | base64 | tr -d '\n')

export LOONGSUITE_PILOT_COLLECT_TRACE=true
export LOONGSUITE_PILOT_OTLP_ENDPOINT=http://localhost:3000/api/public/otel
export LOONGSUITE_PILOT_OTLP_HEADERS="{\"Authorization\": \"Basic $LANGFUSE_AUTH\"}"
```

Pilot will send traces to `http://localhost:3000/api/public/otel/v1/traces` (the `/v1/traces` suffix is auto-appended).

Alternatively, add to `~/.loongsuite-pilot/config.json` (not recommended for shared or version-controlled environments):

```json
{
  "collectTrace": true,
  "otlpTrace": {
    "endpoint": "http://localhost:3000/api/public/otel",
    "headers": {
      "Authorization": "Basic <base64-encoded-credentials>"
    },
    "serviceName": "loongsuite-pilot"
  }
}
```

Open [http://localhost:3000](http://localhost:3000) and navigate to **Traces** to view agent sessions with model name, token usage, and cost details.

> **Note:** Langfuse uses HTTP for OTLP — gRPC (port 4317) is not supported. LLM message content is included in traces by default (`captureMessageContent` defaults to `true`). To disable it, explicitly set `captureMessageContent` to `false` in config.

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
