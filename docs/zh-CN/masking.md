# 数据脱敏

[English](../masking.md) | 简体中文

LoongSuite Pilot 可以在规范化事件发送到输出后端前，对常见密钥进行脱敏。适用于 Prompt、Completion、工具参数或工具结果中可能出现凭证的场景。

脱敏和消息内容采集是两层不同控制：

- `captureMessageContent: false` 会减少是否采集完整消息或工具内容。
- `mask` 会扫描已配置的输出字段，并替换仍然存在的高置信密钥。

敏感环境建议两者同时使用。

## 如何开启脱敏

安装参数：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --mask-mode all
```

自定义模式安装参数：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --mask-mode custom --mask-types apiKey,databaseUrl
```

配置文件：

```json
{
  "mask": {
    "mode": "all"
  }
}
```

环境变量：

```bash
export LOONGSUITE_PILOT_MASK_MODE=all
```

修改配置后重启：

```bash
loongsuite-pilot restart
```

## 脱敏模式

| 模式 | 行为 |
|------|------|
| `none` | 不进行脱敏。未配置 mask mode 时默认使用该模式。 |
| `all` | 开启所有内置敏感数据规则。 |
| `custom` | 只开启 `mask.types` 中列出的脱敏类型。 |

## 脱敏类型

| 类型 | 覆盖内容 |
|------|----------|
| `cloudAccessKey` | 阿里云、AWS、腾讯云风格的 Access Key ID。 |
| `apiKey` | OpenAI-compatible 和 GitHub 风格 API Key。 |
| `privateKey` | PEM 或 OpenSSH 私钥块。 |
| `databaseUrl` | 包含密码的数据库 URL。 |

自定义模式示例：

```json
{
  "mask": {
    "mode": "custom",
    "types": ["apiKey", "databaseUrl"]
  }
}
```

等价环境变量：

```bash
export LOONGSUITE_PILOT_MASK_MODE=custom
export LOONGSUITE_PILOT_MASK_TYPES=apiKey,databaseUrl
```

## 替换标记

规则命中后，Pilot 会使用固定标记替换原始密钥：

| 脱敏类型 | 替换标记 |
|----------|----------|
| `cloudAccessKey` | `[ACCESSKEY_MASKED]` |
| `apiKey` | `[APIKEY_MASKED]` |
| `privateKey` | `[PRIVATEKEY_MASKED]` |
| `databaseUrl` | `[DATABASEURL_MASKED]` |

输出事件中不会保留原始值。

## 哪些字段会被扫描

脱敏发生在 collector 内，先于 JSONL、SLS、HTTP 或 OTLP Trace 输出。

Pilot 重点扫描可能包含用户或工具内容的字段，例如：

- LLM 输入和输出消息。
- 工具调用参数。
- 工具调用结果。
- 已知 Agent 内容字段，例如 `agent.content`、`agent.inline_diff_message` 和部分 compact 内容字段。

模型名、token 数、耗时、Git 分支、workspace 路径等稳定元数据不作为密钥内容字段扫描。

## 推荐隐私配置

敏感或团队统一管理的环境建议：

```json
{
  "mask": {
    "mode": "all"
  },
  "agents": {
    "claude-code": { "captureMessageContent": false },
    "codex": { "captureMessageContent": false },
    "cursor": { "captureMessageContent": false }
  }
}
```

只有当分析确实需要完整 Prompt、Completion、工具参数或工具结果，并且下游存储已被批准时，才建议使用 `captureMessageContent: true`。

## 验证脱敏

1. 开启 JSONL 输出和脱敏。
2. 重启 Pilot。
3. 触发包含测试密钥模式的 Agent 事件。
4. 查看本地输出：

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

预期输出应包含 `[APIKEY_MASKED]` 等脱敏标记，而不是原始密钥。

## 相关配置

- 输出后端配置见 [本地 JSONL 输出](local-jsonl-output.md)、[SLS 输出](sls-output.md)、[Trace 输出](trace-output.md) 和 [HTTP 输出](http-output.md)。
- 敏感内容字段见 [输出事件 Schema](output-event-schema.md)。
