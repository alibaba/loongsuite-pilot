# SLS 输出

[English](../sls-output.md) | 简体中文

SLS 输出会将规范化的 Pilot 事件发送到阿里云日志服务。适用于集中检索、看板、告警或长期存储。

## 安装时开启 SLS

```bash
bash /tmp/loongsuite-pilot-installer.sh install \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore"
```

AK 模式还需要传入：

```bash
--sls-ak-id "your-access-key-id" \
--sls-ak-secret "your-access-key-secret"
```

API Key 模式传入：

```bash
--sls-api-key "your-api-key"
```

不要同时传 `--sls-api-key` 和 `--sls-ak-id` / `--sls-ak-secret`。

## WebTracking 模式

当目标 logstore 支持 WebTracking 写入时使用该模式。

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

## API Key 模式

当目标 SLS 支持采集 API Key 鉴权时使用该模式。Pilot 会走 SLS 直写 protobuf 接口：

- `POST /logstores/{logstore}/shards/lb`
- `Authorization: Bearer <apiKey>`
- `Content-Type: application/x-protobuf`
- `Content-MD5` 为 protobuf body 的大写 hex MD5

这个模式不是 WebTracking query 参数上报。

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

同一个 SLS 目标里不要同时配置 `apiKey` 和 `accessKeyId` / `accessKeySecret`。

## AK 模式

当目标 SLS 需要 Access Key 鉴权时使用该模式。

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

## 多 SLS 目标

使用数组配置可以将同一批事件发送到多个 SLS 目标：

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

## 环境变量

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_SLS_ENDPOINT` | SLS endpoint。 |
| `LOONGSUITE_SLS_PROJECT` | SLS project。 |
| `LOONGSUITE_SLS_LOGSTORE` | SLS logstore。 |
| `LOONGSUITE_SLS_MODE` | `webtracking`、`ak` 或 `apiKey`。 |
| `LOONGSUITE_SLS_API_KEY` | API Key 模式的 API Key。 |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | AK 模式的 Access Key ID。 |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | AK 模式的 Access Key Secret。 |
| `LOONGSUITE_PILOT_COLLECT_LOG` | 设置为 `false` 或 `0` 可关闭 SLS 上报。 |

## 验证 SLS 输出

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

如果 SLS 上传在重试后仍然失败，Pilot 会在本地保存有容量上限的诊断元数据：

```bash
ls ~/.loongsuite-pilot/logs/sls-failed-logs/
```

这些 JSONL 记录只包含 endpoint、错误摘要、batch 条数和 batch 字节数估算，不包含失败 batch payload、消息正文、请求 headers 或凭证，因此不能用于重放失败数据。日志按本地日期和单文件 10MiB 轮转，目录总量限制为 50MiB，同时遵循 `retention.slsFailedDays`（默认 7 天）。

最终的 `FLUSH_SEND_ALARM` 告警消息会包含发送方式、归一化错误分类、结构化错误码、HTTP 状态和实际尝试次数。网络失败还会包含来自错误对象及其 `cause` 链的单行错误摘要；常见凭证格式会被脱敏，摘要最多保留 512 个 UTF-8 字节。HTTP 响应正文不会写入远端告警。这一诊断增强不改变重试判断、尝试次数或退避策略。

调试 SLS 前，可以先通过本地 JSONL 确认采集本身是否正常：

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## 隐私说明

SLS 是远端输出目标。敏感环境中开启前，请先查看 [Agent 配置](agents.md) 的内容采集控制和 [数据脱敏](masking.md)。
