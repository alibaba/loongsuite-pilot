# Input 运行时指标

Pilot 会对 Input 的主数据源做低开销窗口统计，用于比较“实际读取、唯一消费、解析结果、标准事件产出”四个阶段。指标只复用现有读取和解析路径中的数字，不会为统计再次读取日志，也不会保存日志正文、文件路径或失败记录原文。

## 上报周期和位置

- 进程启动时上报一个短窗口；
- 正常运行时每 10 分钟上报一次；
- 正常退出时在 Input 停止并排空事件队列后上报最后一个短窗口；
- 远端仍使用 `pilot_pipeline`，Input 行的 `type` 为 `input`；
- 本地镜像位于 `logs/metric_alarm/pilot-input-metrics.jsonl`。

当前窗口维度是固定的 `agent + input_name + source_kind + collection_method`。不包含 `session_id`、`turn_id`、`trace_id`、动态文件名或文件路径，因此上报行数和常驻内存不会随源记录数增长。

## 字段说明

| 字段 | 聚合方式 | 含义 |
|------|----------|------|
| `raw_read_calls` | 求和 | 主源文件 API 的实际读取调用次数，重复扫描会重复累计。 |
| `raw_read_bytes` | 求和 | 文件 API 实际返回的 `bytesRead` 总和，重复扫描会重复累计；它不是磁盘设备层 I/O。 |
| `raw_in_records` | 求和 | checkpoint 首次跨过的完整、非空记录数，解析失败的记录也计入。 |
| `raw_in_bytes` | 求和 | checkpoint 唯一向前推进的完整源字节，包含换行和空白字节。 |
| `raw_in_max_batch_bytes` | 最大值 | 本窗口最大单次读取 Buffer 大小。 |
| `raw_in_max_record_bytes` | 最大值 | 本窗口最大完整记录字节数，包含换行。 |
| `raw_backlog_bytes_max` | 最大值 | 本窗口观测到的最大 `source_size - committed_offset`。 |
| `parse_success_records` | 求和 | 唯一消费记录中，JSON 解析成功且结果为对象的数量。 |
| `parse_failed_records` | 求和 | 唯一消费记录中，JSON 无效或结果不是对象的数量。 |
| `read_duration_ms` | 求和 | 主源文件读取等待的单调时钟墙钟耗时。 |
| `process_duration_ms` | 求和 | collect 总墙钟时间扣除主源读取时间后的耗时，包含解析、过滤、回读处理、扩展和转换，不等同于纯 CPU 时间。 |
| `in_events` | 求和 | Input 最终产出的标准事件数。 |
| `in_bytes` | 求和 | 标准事件序列化后的字节数。 |
| `failed_events` | 求和 | 标准事件交给后续处理时失败的数量。 |

行式输入满足：

```text
parse_success_records + parse_failed_records = raw_in_records
```

一条源记录可能被过滤后不产生事件，也可能产生多个标准事件，因此 `raw_in_records` 与 `in_events` 不要求相等。

## 示例

Codex transcript 出现重复回读和少量坏 JSON 时：

```json
{
  "type": "input",
  "agent": "codex",
  "input_name": "codex-transcript",
  "source_kind": "primary",
  "collection_method": "session-file-polling",
  "window_ms": "600000",
  "raw_read_calls": "152",
  "raw_read_bytes": "335544320",
  "raw_in_records": "8450",
  "raw_in_bytes": "100663296",
  "raw_in_max_batch_bytes": "16777216",
  "raw_in_max_record_bytes": "3145728",
  "raw_backlog_bytes_max": "67108864",
  "parse_success_records": "8446",
  "parse_failed_records": "4",
  "read_duration_ms": "740",
  "process_duration_ms": "3120",
  "in_events": "380",
  "in_bytes": "11534336",
  "failed_events": "0"
}
```

其中 `raw_read_bytes / raw_in_bytes` 明显大于 1，说明存在重复扫描或回读；再结合 `parse_failed_records`、处理耗时和事件产出，可以区分读取放大、解析失败与后续过滤/转换。

Qoder Trace 使用同一字段契约，但一期只统计产生事件的主 Hook JSONL；segment、intercept 和 SQLite 扩展读取不会混入 `source_kind=primary`。

## 覆盖边界

- 已覆盖继承公共 `BaseHookInput` 和 `BaseSessionInput` 且未重写读取流程的 Input；
- 已显式覆盖 `qoder-trace` 主 Hook JSONL；
- 已显式覆盖 `codex-transcript` 的正常扫描、边界查找、恢复和元数据回读；
- `dsh-log`、`qoder-work-log`、`qoder-work-trace` 等重写了公共读取流程的 Input 暂不误报原始读取量，后续需要分别接入；
- 不新增或修改 `pilot_trace_runtime`，不负责 session/turn 缓存、生命周期、异常或释放明细。
