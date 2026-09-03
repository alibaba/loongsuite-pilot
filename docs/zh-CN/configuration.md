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
  "dashboard": { "port": 8765 },
  "serviceName": "my-agent-service"
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | collector 总开关。 |
| `dataDir` | 本地运行和数据目录。 |
| `userId` | 写入输出事件的用户标识，默认使用机器 hostname。 |
| `collectLog` | 控制 SLS 日志上报。JSONL 和 HTTP 由各自的 `enabled` 控制。 |
| `collectTrace` | 当配置了 Trace 目标时，控制 OTLP Trace 上报。 |
| `dashboard.port` | 本机 Dashboard 端口。仅接受 1 到 65535 的整数，非法值回退到 `8765`。 |
| `serviceName` | 所有 Agent 和上报后端共用的唯一服务名，优先级高于所有服务名前缀配置。 |
| `serviceNamePrefix` | 兼容原有行为的服务名基础值。未设置 `serviceName` 时，各 Agent 以 `<serviceNamePrefix>-<agentType>` 上报。 |

对应环境变量：

| 环境变量 | 说明 |
|----------|------|
| `AGENT_DATA_COLLECTION_CONFIG` | 自定义配置文件路径。 |
| `LOONGSUITE_PILOT_ENABLED` | 设置为 `false` 或 `0` 可关闭 collector。 |
| `LOONGSUITE_PILOT_DATA_DIR` | 覆盖数据目录。 |
| `LOONGSUITE_PILOT_USER_ID` | 覆盖 `userId`。 |
| `LOONGSUITE_PILOT_COLLECT_LOG` | 设置为 `false` 或 `0` 可关闭 SLS 日志上报。 |
| `LOONGSUITE_PILOT_COLLECT_TRACE` | 设置为 `false` 或 `0` 可关闭 Trace 上报。 |
| `LOONGSUITE_PILOT_SERVICE_NAME` | 用一个唯一服务名覆盖所有 Agent 和上报后端的 `serviceName`。 |
| `LOONGSUITE_PILOT_SERVICE_NAME_PREFIX` | 覆盖 `serviceNamePrefix`。 |
| `LOG_LEVEL` | 运行日志级别：`debug`、`info`、`warn`、`error` 或 `silent`。 |

## SLS 密钥配置

SLS 目标支持 WebTracking、AK/SK 和 API Key 模式。API Key 模式会把 key 写入本地 `config.json`，请确保文件权限合适，不要把该文件分享出去。

```json
{
  "sls": {
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "apiKey",
    "apiKey": "your-api-key"
  }
}
```

同一个 SLS 目标里不要同时配置 `apiKey` 和 `accessKeyId` / `accessKeySecret`。完整模式示例见 [SLS 输出](sls-output.md)。

## 多模态对象存储

> **实验性。** 多模态配置和事件字段可能调整。

把 Agent 消息里的图片（内联 base64，或本地路径读入后编码）存到对象存储，事件里只留 `uri`。在 `config.json` 配置 `multimodal.storage`：`type`、`target`、`auth`。是否上传由各 Agent 的 `agents.<id>.multimodal.uploadMode` 决定；本地读文件的范围是 `agents.<id>.multimodal.allowedRootPaths` 加上该 Agent 默认根。详见 [多模态采集](multimodal.md)。

`type` 选一种：`sls`、`delegatedOss` 或 `oss`。这和日志用的 `sls` flusher 不是同一块配置。`sls` / `delegatedOss` 不用手写存储前缀，Pilot 会按 `project` / `logstore` 使用 `sls://{project}/{logstore}`。

`auth` 填写一套完整的 ApiKey 或 AK。未填 `mode` 时按这套凭证推断。

### `type: sls`

通过 SLS PutObject 写入。事件 URI 为 `sls://{project}/{logstore}/{YYYYMMDD}/{sha256}.ext`。

```json
{
  "multimodal": {
    "storage": {
      "type": "sls",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal"
      },
      "auth": {
        "mode": "ak",
        "accessKeyId": "your-access-key-id",
        "accessKeySecret": "your-access-key-secret"
      }
    }
  }
}
```

用 ApiKey：

```json
{
  "multimodal": {
    "storage": {
      "type": "sls",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal"
      },
      "auth": {
        "mode": "apiKey",
        "apiKey": "your-sls-project-api-key"
      }
    }
  }
}
```

### `type: delegatedOss`

先向 SLS 换预签名，再写入 OSS。事件 URI 为 `oss://{bucket}/{project}/{logstore}/{YYYYMMDD}/{sha256}.ext`。启动时会向 SLS 确认当前落地 Bucket。可选填写 `target.ossBucket` 做核对：和当前落地 Bucket 不一致，或确认失败，则不开启图片上传。

```json
{
  "multimodal": {
    "storage": {
      "type": "delegatedOss",
      "target": {
        "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
        "project": "your-project",
        "logstore": "logstore-multimodal",
        "ossBucket": "your-bucket"
      },
      "auth": {
        "mode": "apiKey",
        "apiKey": "your-sls-project-api-key"
      }
    }
  }
}
```

### `type: oss`

直连 OSS，只能用 AK。

```json
{
  "multimodal": {
    "storage": {
      "type": "oss",
      "target": {
        "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
        "storageBasePath": "oss://your-bucket/pilot-mm"
      },
      "auth": {
        "mode": "ak",
        "accessKeyId": "your-access-key-id",
        "accessKeySecret": "your-access-key-secret"
      }
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `multimodal.storage.type` | `sls`、`delegatedOss` 或 `oss`。 |
| `multimodal.storage.target.endpoint` | SLS 或 OSS 区域 Endpoint（OSS 不支持 accelerate）。 |
| `multimodal.storage.target.project` | SLS Project。`sls` / `delegatedOss` 必填。 |
| `multimodal.storage.target.logstore` | 存放多模态对象的 Logstore；缺省 `logstore-multimodal`。 |
| `multimodal.storage.target.ossBucket` | 可选，仅 `delegatedOss`。用来核对落地 Bucket；不一致则不开启图片上传。 |
| `multimodal.storage.target.storageBasePath` | `oss` 必填，须以 `oss://` 开头，例如 `oss://bucket/prefix`。 |
| `multimodal.storage.auth.mode` | 可选。`ak` 或 `apiKey`。未填时按已填写的凭证推断。`type=oss` 必须是 `ak`。 |
| `multimodal.storage.auth.accessKeyId` / `accessKeySecret` | `mode=ak` 时必填；STS 可加 `securityToken`。 |
| `multimodal.storage.auth.apiKey` | `mode=apiKey` 时必填。不能与 AK 同时写。 |

`multimodal.storage` 缺失或无效时，文本采集照常，图片不会转成 `uri`。

## 配置主题

| 任务 | 文档 |
|------|------|
| 选择采集哪些 Agent，是否采集消息内容 / 多模态 | [Agent 配置](agents.md)、[多模态采集](multimodal.md) |
| 写入本地 JSONL 文件 | [本地 JSONL 输出](local-jsonl-output.md) |
| 上报日志到阿里云 SLS | [SLS 输出](sls-output.md) |
| 将 GenAI 活动上报为 OTLP Trace | [Trace 输出](trace-output.md) |
| POST 到自定义 HTTP 接口 | [HTTP 输出](http-output.md) |
| 脱敏 API Key、AccessKey、私钥、数据库 URL 和个人敏感信息 | [数据脱敏](masking.md) |

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
    "slsFailedDays": 7,
    "otlpFailedDays": 7,
    "metricAlarmDays": 7
  }
}
```

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_PILOT_LOG_RETENTION_ENABLED` | 开启或关闭保留清理。 |
| `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` | 对所有日志类别使用统一保留天数。 |
| `LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS` | 清理间隔。 |

`otlpFailedDays` 控制 `logs/otlp-failed` 中受管文件的保留天数；
`metricAlarmDays` 控制 `logs/metric_alarm` 中指标、告警和 Updater 事件文件的
保留天数，二者默认都是 7 天。这些日志按本地日期每天写一个文件，不按单文件
大小轮转。后台定时清理时，如果受管 OTLP 失败日志超过 512 MiB，或受管指标
告警日志超过 256 MiB，Pilot 会从最旧文件开始删除，但始终保留当天和昨天。
这些容量值是软清理目标，两次清理之间或当天文件持续增长时可以暂时超过。
旧的无日期文件按修改日期参与清理；关闭定时保留后，按天数和容量的清理都不
执行。`token-usage-state.json` 仍是覆盖写状态文件，不参与这项清理。

## 验证配置

修改配置后重启并查看状态：

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

最快的验证方式是启用 [本地 JSONL 输出](local-jsonl-output.md)，检查是否有新事件写入。
