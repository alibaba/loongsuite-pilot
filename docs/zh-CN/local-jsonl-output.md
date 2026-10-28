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
写入并告警，下次追加前滚动。既有活跃文件超过 3 GiB 时，下一次写入前先删除该本地副本并记录告警；不再继续追加到异常巨型文件。
`rotateDaily=false` 时文件名以 `all` 代替日期。

## 保留和磁盘保护

本地 JSONL 输出遵循 [配置总览](configuration.md) 里的全局保留策略。默认情况下，Output 日志保留 7 天。

Pilot 也内置了针对异常大日志的磁盘保护清理：

- 单个 Output 文件超过 512 MiB，且已经超过 2 天时，可以被提前清理。
- 如果 `logs/output` 超过 2 GiB，周期清理会优先淘汰较老的可清理文件和封存的 `part` 分片，当天封存分片也可淘汰。
- 超过 **3 GiB** 的本地输出文件不再受今天、昨天或活跃文件保护，定期检查会删除它；即使 Agent 已停止写入的旧巨型文件也会回收。3 GiB 指 `3 × 1024³` 字节，严格大于该值才触发。
- 未超过异常阈值的当天和昨天未分片文件、当前活跃文件继续保留；封存的 `all` 分片按修改日期参与清理。活跃文件和单条超大事件可能使目录仍高于水位；这是周期保留目标，不是实时磁盘配额。
- 默认启动后约 30 秒执行首次完整清理，完整保留扫描仍默认每 6 小时执行；另对 `output`、`otlp-debug`、`otlp-failed` 每 60 秒执行容量检查（配置的完整清理间隔更短时复用更短间隔）。写入、滚动和异常文件删除共用进程内文件锁；扫描清理会重新核对文件类型和大小。

`logs/otlp-debug` 和 `logs/otlp-failed` 也默认按 100 MiB 滚动。调试副本沿用 2 GiB 目录保留目标；失败副本沿用 512 MiB 目标，并允许在容量压力下淘汰当天已封存分片。超过 3 GiB 的失败文件同样紧急回收，丢弃失败证据会明确记录告警。这是磁盘保护，**不代表这些失败数据已成功上报，也不保证以后能重放**。

JSONL 是与远端发送并行的本地副本，不是带逐文件 ACK 的待发送队列。清理本地分片不等待远端确认，不删除 Agent 的源 transcript、原生遥测和采集状态。自定义 `jsonl.outputDir` 可以写入和滚动，但上述周期清理只管理数据目录下的 `logs/output` 等固定目录；自定义目录的总容量由调用方管理。

Dashboard 保留当天已经扫描过的文件身份累计统计；滚动、替换或清理后不撤回此前观察到的数据，重启可复用缓存。重复内容替换文件不按事件 ID 去重。分片在首次扫描前就被清理，或统计缓存丢失时，只能从剩余文件重建，不能保证还原已经删除的数据量。
Dashboard 不再打开超过 3 GiB 的异常输出文件进行统计，避免启动时扫描即将被回收的巨型文件；已缓存的当天统计保留，未扫描部分不补造。

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
