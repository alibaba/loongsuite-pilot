# Trace 输出

[English](../trace-output.md) | 简体中文

Trace 输出会将 GenAI 活动导出为 OpenTelemetry Trace。适用于在 Trace 或 APM 后端中分析会话、轮次、模型调用和工具调用。

Trace 输出和日志输出是分开的。SLS、JSONL、HTTP 接收事件记录；OTLP Trace 输出会将这些记录转换为 Trace spans。

## 通用 OTLP Trace 输出

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

| 配置项 | 说明 |
|--------|------|
| `collectTrace` | Trace 上报总开关。 |
| `otlpTrace.endpoint` | OTLP HTTP base URL。如果路径未以 `/v1/traces` 结尾，Pilot 会自动追加。 |
| `otlpTrace.headers` | 发送到 OTLP endpoint 的请求头。 |
| `otlpTrace.serviceName` | 导出 span 使用的 service name。 |
| `otlpTrace.resourceAttributes` | 额外 OpenTelemetry resource attributes。 |
| `otlpTrace.captureMessageContent` | Trace 输出是否可以包含消息内容。 |
| `otlpTrace.debug` | 开启 Trace 转换 debug 本地输出。 |
| `otlpTrace.turnIdleTimeoutMs` | 可选的 turn 级 Trace 聚合空闲超时。 |

环境变量：

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_PILOT_COLLECT_TRACE` | 设置为 `false` 或 `0` 可关闭 Trace 上报。 |
| `LOONGSUITE_PILOT_OTLP_ENDPOINT` | OTLP Trace endpoint。 |
| `LOONGSUITE_PILOT_OTLP_HEADERS` | OTLP 请求头 JSON 字符串。 |

## ARMS/CMS 兼容 Trace 输出

Pilot 也支持 CMS 风格的 Trace 配置：

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

环境变量：

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_PILOT_CMS_LICENSE_KEY` | CMS 或 ARMS license key。 |
| `LOONGSUITE_PILOT_CMS_ENDPOINT` | CMS 或 ARMS Trace endpoint。 |
| `LOONGSUITE_PILOT_CMS_WORKSPACE` | workspace header 值。 |

## 后端接入示例

### Jaeger

[Jaeger](https://www.jaegertracing.io/) 原生支持 OTLP 数据接收。使用 v2 镜像快速搭建本地环境：

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.19.0
```

> **注意：** Pilot 使用 HTTP/protobuf 协议进行 OTLP 导出（端口 4318）。端口 4317（gRPC）仅为其他可能需要的工具暴露。

配置 Pilot：

```json
{
  "collectTrace": true,
  "otlpTrace": {
    "endpoint": "http://localhost:4318",
    "serviceName": "loongsuite-pilot"
  }
}
```

或通过环境变量：

```bash
export LOONGSUITE_PILOT_OTLP_ENDPOINT=http://localhost:4318
export LOONGSUITE_PILOT_COLLECT_TRACE=true
```

打开 [http://localhost:16686](http://localhost:16686)，选择 service name 查看 Trace。

### Langfuse

[Langfuse](https://langfuse.com/) 是一个 LLM 可观测平台，原生支持 OTLP 接入，提供成本追踪、Token 用量、Prompt/Completion 内容等 LLM 专属视图。

**1. 启动 Langfuse（自部署）：**

```bash
mkdir -p ~/langfuse && cd ~/langfuse
curl -sLO https://raw.githubusercontent.com/langfuse/langfuse/v3.187.0/docker-compose.yml

# 生成随机密钥（生产环境请勿使用占位符）
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

> **安全提示：** 上述 `.env` 文件会自动生成随机密钥。`umask 077` 确保文件仅当前用户可读。启动服务前请检查生成的 `.env` 文件，并记录生成的登录密码。

**2. 配置 Pilot：**

Langfuse OTLP endpoint 需要 Basic 认证，格式为 `Base64(public_key:secret_key)`。推荐通过环境变量配置，避免将凭证写入配置文件：

```bash
LANGFUSE_AUTH=$(printf '%s' 'pk-lf-my-public-key:sk-lf-my-secret-key' | base64 | tr -d '\n')

export LOONGSUITE_PILOT_COLLECT_TRACE=true
export LOONGSUITE_PILOT_OTLP_ENDPOINT=http://localhost:3000/api/public/otel
export LOONGSUITE_PILOT_OTLP_HEADERS="{\"Authorization\": \"Basic $LANGFUSE_AUTH\"}"
```

Pilot 会将 Trace 发送到 `http://localhost:3000/api/public/otel/v1/traces`（`/v1/traces` 后缀自动追加）。

也可以添加到 `~/.loongsuite-pilot/config.json`（不推荐在共享或版本控制环境中使用）：

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

打开 [http://localhost:3000](http://localhost:3000)，进入 **Traces** 页面查看 Agent 会话，包括模型名称、Token 用量和费用详情。

> **注意：** Langfuse 使用 HTTP 接收 OTLP 数据，不支持 gRPC（端口 4317）。LLM 消息内容默认包含在 Trace 中（`captureMessageContent` 默认为 `true`）。如需关闭，请在配置中显式设置 `captureMessageContent` 为 `false`。

## Trace 中的内容采集

如果开启消息内容采集，Trace span 可能包含敏感内容。敏感或团队统一管理的环境建议：

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

如果 Trace 数据可能包含密钥，也建议开启 [数据脱敏](masking.md)。

## 验证 Trace 输出

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

如果开启了 `otlpTrace.debug` 或 `cms.debug`，debug 输出会写入：

```text
~/.loongsuite-pilot/logs/otlp-debug/
```

Trace 导出失败的数据可能会持久化到：

```text
~/.loongsuite-pilot/logs/otlp-failed/
```
