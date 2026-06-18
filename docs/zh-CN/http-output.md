# HTTP 输出

[English](../http-output.md) | 简体中文

HTTP 输出会将规范化的 Pilot 事件 POST 到自定义接口。适用于已有采集网关，或希望将 Pilot 数据接入自己的服务。

## 配置 HTTP 输出

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

| 配置项 | 说明 |
|--------|------|
| `enabled` | 开启或关闭 HTTP 输出。 |
| `url` | 接收 POST 请求的接口。 |
| `headers` | 可选请求头。 |
| `batchMaxSize` | 每批最多事件数。 |
| `flushIntervalMs` | 批次最大等待时间。 |
| `requestTimeoutMs` | 请求超时时间，单位毫秒。 |

环境变量：

| 环境变量 | 说明 |
|----------|------|
| `HTTP_REPORT_URL` | HTTP endpoint。非空时会启用 HTTP 输出。 |
| `HTTP_REPORT_HEADERS` | 请求头 JSON 字符串。 |

## 验证 HTTP 输出

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

首次接入 HTTP 输出时，建议保留本地 JSONL。即使自定义接口拒绝请求，也可以通过 JSONL 确认采集是否正常。

## 隐私说明

HTTP 是远端输出目标。敏感环境中开启前，请先查看 [Agent 配置](agents.md) 的内容采集控制和 [数据脱敏](masking.md)。
