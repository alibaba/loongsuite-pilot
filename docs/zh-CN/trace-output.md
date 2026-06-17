# Trace 输出

[English](../trace-output.md) | 简体中文

Trace 输出会将 GenAI 活动导出为 OpenTelemetry Trace。适用于在 Trace 或 APM 后端中分析会话、轮次、模型调用和工具调用。

Trace 输出和日志输出是分开的。SLS、JSONL、HTTP 接收事件记录；OTLP Trace 输出会将这些记录转换为 Trace spans。

## 通用 OTLP Trace 输出

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

| 配置项 | 说明 |
|--------|------|
| `collectTrace` | Trace 上报总开关。 |
| `otlpTrace.endpoint` | OTLP HTTP Trace endpoint。 |
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
