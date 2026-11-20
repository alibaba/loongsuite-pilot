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

`install` 命令不修改已有的 `sls` 数组，检测到后会报错退出；请手动编辑 `config.json` 中的目标和 Key。`upgrade` 命令会保留该文件。

## 环境变量

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_SLS_ENDPOINT` | SLS endpoint。 |
| `LOONGSUITE_SLS_PROJECT` | SLS project。 |
| `LOONGSUITE_SLS_LOGSTORE` | SLS logstore。 |
| `LOONGSUITE_SLS_MODE` | `webtracking`、`ak` 或 `apiKey`。 |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | AK 模式的 Access Key ID。 |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | AK 模式的 Access Key Secret。 |
| `LOONGSUITE_PILOT_COLLECT_LOG` | 设置为 `false` 或 `0` 可关闭 SLS 上报。 |
| `LOONGSUITE_PILOT_HOST_IDENTITY_TAGS` | 设置为 `false` 或 `0` 时不带 `__mac__` 和 `__sn__`。未设置时使用配置里的 `hostIdentityTags`。 |

API Key 模式从 `config.sls` 读取 `apiKey`，不再支持环境变量覆盖。

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

`FLUSH_SEND_ALARM` 告警消息包含发送方式、归一化错误分类、结构化错误码、HTTP 状态和实际尝试次数。网络失败还会包含来自错误对象及其 `cause` 链的单行摘要，常见凭证格式会被脱敏，摘要最多保留 512 个 UTF-8 字节。HTTP 响应正文不会写入远端告警。`failure_class` 字段标识处置类别。

| 处置类别 | 行为 |
|----------|------|
| `transient` | 同一 endpoint 连续三轮只有临时失败时告警，一次发送成功会重置连续失败计数。 |
| `quota` | 识别 AK SDK 和 HTTP 传输返回的结构化 SLS 写入配额错误码。HTTP 传输也识别状态码 429。上报 `FLUSH_QUOTA_ALARM`。 |
| `config` | 已识别的 Project 或 Logstore 终态错误。同一 endpoint 连续三轮只有终态配置错误后，暂缓发送其队列。 |
| `payload` | 后端拒绝超限请求，或 Pilot 在发送前发现单条 WebTracking 记录超限。本地拒绝时显示 `attempts=0`。 |

临时失败和配置失败告警分别按 endpoint 冷却一小时。配置失败的暂缓期结束后，Pilot 用一条排队记录探测。探测请求失败会延长暂缓，最长十分钟。仍可发送的探测记录会留在队列中。发送成功后恢复队列。等待中的记录暂存在内存。队列压力过高或服务正常退出时，可以在暂缓期间执行正常发送。

WebTracking 按完整 JSON 请求体计算大小，包括标签与分隔符。尽力发送的队列对阿里云 SLS 标准 endpoint 检查文档规定的单次请求上限。超限记录计入发送失败并写入本地诊断。自定义 endpoint 使用自身的上限和返回状态。Codex 记录完整发送到配置的 endpoint，仍需等待传输确认。

调试 SLS 前，可以先通过本地 JSONL 确认采集本身是否正常：

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## 隐私说明

SLS 是远端输出目标。敏感环境中开启前，请先配置[数据脱敏](masking.md)。

`__tag__:__mac__` 和 `__source__` 用的是同一块网卡：采集进程启动时，取 `os.networkInterfaces()` 里第一块非回环 IPv4。全零 MAC 不写这个标签。

`__tag__:__sn__` 来自安装时写入 `config.json` 的 `hostSn`。macOS 安装脚本读 `ioreg`，Linux 读 DMI 文件，Windows 安装脚本读 CIM。Linux 上这些文件通常只有 root 能读，读不到就不写该字段。占位符和超过 128 字节的值也不写。配置里没有 `hostSn` 就没有这个标签。删掉之后不再上报。再次执行安装时如果还能读到，会再写回去。普通升级保留已有配置，不会补写。`hostIdentityTags` 设为 `false` 时，主采集和 Qoder 都不带这两个标签。脱敏不会去掉它们。
