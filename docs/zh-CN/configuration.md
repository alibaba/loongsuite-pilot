# 配置总览

[English](../configuration.md) | 简体中文

LoongSuite Pilot 可以通过安装参数、环境变量和 `config.json` 配置。本文说明配置位置、加载顺序和全局开关，并链接到具体任务文档。

## 配置加载顺序

Pilot 按以下顺序解析配置：

1. 环境变量。
2. 配置文件，默认路径为 `~/.loongsuite-pilot/config.json`。
3. 内置默认值。

如需使用其他配置文件路径，可以设置 `AGENT_DATA_COLLECTION_CONFIG`。

## 常用全局配置

```jsonc
{
  "enabled": true,
  "dataDir": "~/.loongsuite-pilot",
  "userId": "your-user-id",
  "collectLog": true,
  "collectTrace": true,
  "serviceNamePrefix": "loongsuite-pilot"
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | collector 总开关。 |
| `dataDir` | 本地运行和数据目录。 |
| `userId` | 写入输出事件的用户标识，默认使用机器 hostname。 |
| `collectLog` | 控制 SLS 日志上报。JSONL 和 HTTP 由各自的 `enabled` 控制。 |
| `collectTrace` | 当配置了 Trace 目标时，控制 OTLP Trace 上报。 |
| `serviceNamePrefix` | 上报后端使用的服务名前缀。 |

对应环境变量：

| 环境变量 | 说明 |
|----------|------|
| `AGENT_DATA_COLLECTION_CONFIG` | 自定义配置文件路径。 |
| `LOONGSUITE_PILOT_ENABLED` | 设置为 `false` 或 `0` 可关闭 collector。 |
| `LOONGSUITE_PILOT_DATA_DIR` | 覆盖数据目录。 |
| `LOONGSUITE_PILOT_USER_ID` | 覆盖 `userId`。 |
| `LOONGSUITE_PILOT_COLLECT_LOG` | 设置为 `false` 或 `0` 可关闭 SLS 日志上报。 |
| `LOONGSUITE_PILOT_COLLECT_TRACE` | 设置为 `false` 或 `0` 可关闭 Trace 上报。 |
| `LOONGSUITE_PILOT_SERVICE_NAME_PREFIX` | 覆盖 `serviceNamePrefix`。 |
| `LOG_LEVEL` | 运行日志级别：`debug`、`info`、`warn`、`error` 或 `silent`。 |

## 配置主题

| 任务 | 文档 |
|------|------|
| 选择采集哪些 Agent，是否采集消息内容 | [Agent 配置](agents.md) |
| 写入本地 JSONL 文件 | [本地 JSONL 输出](local-jsonl-output.md) |
| 上报日志到阿里云 SLS | [SLS 输出](sls-output.md) |
| 将 GenAI 活动上报为 OTLP Trace | [Trace 输出](trace-output.md) |
| POST 到自定义 HTTP 接口 | [HTTP 输出](http-output.md) |
| 脱敏 API Key、AccessKey、私钥和数据库 URL | [数据脱敏](masking.md) |

## 日志保留

Pilot 可以定期清理本地运行日志。

```json
{
  "retention": {
    "enabled": true,
    "hookHistoryDays": 7,
    "hookErrorDays": 7,
    "hookDebugDays": 7,
    "outputDays": 7,
    "slsFailedDays": 7
  }
}
```

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` | 开启或关闭保留清理。 |
| `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` | 对所有日志类别使用统一保留天数。 |
| `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` | 清理间隔。 |

## 验证配置

修改配置后重启并查看状态：

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

最快的验证方式是启用 [本地 JSONL 输出](local-jsonl-output.md)，检查是否有新事件写入。
