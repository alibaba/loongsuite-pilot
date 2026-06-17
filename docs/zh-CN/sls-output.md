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
| `LOONGSUITE_SLS_MODE` | `webtracking` 或 `ak`。 |
| `LOONGSUITE_SLS_ACCESS_KEY_ID` | AK 模式的 Access Key ID。 |
| `LOONGSUITE_SLS_ACCESS_KEY_SECRET` | AK 模式的 Access Key Secret。 |
| `LOONGSUITE_PILOT_COLLECT_LOG` | 设置为 `false` 或 `0` 可关闭 SLS 上报。 |

## 验证 SLS 输出

```bash
loongsuite-pilot restart
loongsuite-pilot status
```

如果 SLS 上传失败，失败批次会持久化到本地：

```bash
ls ~/.loongsuite-pilot/sls-failed-logs/
```

调试 SLS 前，可以先通过本地 JSONL 确认采集本身是否正常：

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

## 隐私说明

SLS 是远端输出目标。敏感环境中开启前，请先查看 [Agent 配置](agents.md) 的内容采集控制和 [数据脱敏](masking.md)。
