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
<agent-id>.part-<id>-YYYY-MM-DD.jsonl
```

第一种是当前写入文件，带 `part` 唯一标识的是按大小滚动后封存的分片。
日期后缀仍可被 Dashboard 和保留清理识别。每一行是一条规范化事件。

JSONL 会保留原生 JSON 类型：token 数量保持 number，标志位保持 boolean，
消息和工具载荷保持 array/object。宽表日志等只接受字符串列的后端，应只在各自
输出边界完成序列化，不能影响本地 JSONL。

## 开启或关闭 JSONL

```json
{
  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/output",
    "rotateDaily": true,
    "maxFileSizeMb": 100
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 开启或关闭本地 JSONL 输出。 |
| `outputDir` | 输出文件目录。 |
| `rotateDaily` | 按日期写入文件。 |
| `maxFileSizeMb` | 下一条事件会使文件超过此 MiB 数时先滚动，默认 100；Agent 事件、原始 topic 及 `rotateDaily=false` 均生效。非正数或非有限数回退默认值。 |

单条 JSON 事件不会为满足文件限制而被拆分或截断。超过限制的单条事件完整
写入并告警，下次追加前滚动；已有超大文件也在下次写入前滚动。
`rotateDaily=false` 时文件名以 `all` 代替日期。

## 保留和磁盘保护

本地 JSONL 输出遵循 [配置总览](configuration.md) 里的全局保留策略。默认情况下，Output 日志保留 7 天。

Pilot 也内置了针对异常大日志的磁盘保护清理：

- 单个 Output 文件超过 512 MiB，且已经超过 2 天时，可以被提前清理。
- 如果 `logs/output` 超过 2 GiB，周期清理会优先淘汰较老的可清理文件和封存的 `part` 分片，当天封存分片也可淘汰。
- 当天和昨天未分片的文件、当前活跃文件继续保留；封存的 `all` 分片按修改日期参与清理。活跃文件和单条超大事件可能使目录仍高于水位；这是周期保留目标，不是实时磁盘配额。

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

JSONL 虽然是本地文件，但仍可能包含敏感内容。建议：

- 开启 [数据脱敏](masking.md)。
