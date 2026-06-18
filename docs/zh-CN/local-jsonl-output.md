# 本地 JSONL 输出

[English](../local-jsonl-output.md) | 简体中文

本地 JSONL 输出会把规范化后的 Pilot 事件写入本机文件。它默认开启，是配置远端上报前验证采集是否生效的最简单方式。

## 默认路径

```text
~/.loongsuite-pilot/logs/output/
```

文件按 Agent 和日期命名：

```text
<agent-id>-YYYY-MM-DD.jsonl
```

每一行是一条规范化事件。

## 开启或关闭 JSONL

```json
{
  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/output",
    "rotateDaily": true
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 开启或关闭本地 JSONL 输出。 |
| `outputDir` | 输出文件目录。 |
| `rotateDaily` | 按日期写入文件。 |

环境变量：

| 环境变量 | 说明 |
|----------|------|
| `JSONL_ENABLED` | 开启或关闭 JSONL 输出。 |
| `JSONL_OUTPUT_DIR` | 覆盖 JSONL 输出目录。 |

## 验证本地输出

修改配置后重启：

```bash
loongsuite-pilot restart
```

查看文件：

```bash
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

如果没有输出，请确认至少有一个支持的 Agent 已安装、已启用，并且在 Pilot 启动后产生了新活动。

## 隐私说明

JSONL 虽然是本地文件，但如果开启了消息内容采集，也可能包含敏感内容。建议：

- 通过 [Agent 配置](agents.md) 关闭完整内容采集。
- 开启 [数据脱敏](masking.md)。
