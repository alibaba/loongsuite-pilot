# Input 运行时指标

Pilot 会对 Input 的主数据源做低开销窗口统计，用于比较“实际读取、正常消费、解析结果、标准事件产出”四个阶段。指标不会为统计再次读取或 `stat` 日志，也不会保存日志正文、文件路径或失败记录原文；非 ASCII JSONL 为精确计算最大记录字节数，会在已经读入的 Buffer 上做一次只向前的换行定位，不产生额外源文件 I/O。

## 上报周期和位置

- 进程启动时上报一个短窗口；
- 正常运行时每 10 分钟上报一次；
- 正常退出时在 Input 停止并排空事件队列后上报最后一个短窗口；
- 远端仍使用 `pilot_pipeline`，Input 行的 `type` 为 `input`；
- 本地镜像按本地日期写入 `logs/metric_alarm/pilot-input-metrics-YYYY-MM-DD.jsonl`。

当前窗口维度是固定的 `agent + input_name + source_kind + collection_method`。不包含 `session_id`、`turn_id`、`trace_id`、动态文件名或文件路径，因此上报行数和常驻内存不会随源记录数增长。

原始输入指标只出现在 `type=input` 明细行，不写入 L1 `pilot_status` 或 `type=agent` 聚合行。当前并非所有自定义 Input 都已接入原始读取统计，将部分原始量与完整事件量直接汇总会产生误导；需要 Agent 维度时，可对 Input 行按 `agent` 聚合。

## 字段说明

| 字段 | 聚合方式 | 含义 |
|------|----------|------|
| `raw_read_calls` | 求和 | 主源文件 API 的实际读取调用次数，重复扫描会重复累计。 |
| `raw_read_bytes` | 求和 | 文件 API 实际返回的 `bytesRead` 总和，重复扫描会重复累计；它不是磁盘设备层 I/O。 |
| `raw_in_records` | 求和 | 进入正常消费漏斗并首次提交的完整、非空记录数，解析失败的记录也计入。会话边界定位和 baseline 历史跳过不计入。 |
| `raw_in_bytes` | 求和 | 进入正常消费漏斗并首次提交的完整源字节，包含换行和空白字节。会话边界定位和 baseline 历史跳过不计入。 |
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

计数和耗时字段跨窗口查询时使用求和；`raw_in_max_batch_bytes`、`raw_in_max_record_bytes`、`raw_backlog_bytes_max` 是窗口最大值，应使用最大值聚合，不能求和。

当前 `raw_*` 在采集周期结束时提交，`in_events` 在异步事件处理队列中提交。同一批数据若恰好跨越10分钟窗口边界，两个阶段可能出现在相邻窗口；定位时应同时查看相邻窗口或按更长时间范围求和。本期不改变这条执行链。

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

其中 `raw_read_bytes` 明显大于 `raw_in_bytes` 表示存在读取放大，可能来自重复扫描、会话边界定位或历史数据过滤；再结合 `parse_failed_records`、处理耗时和事件产出，可以区分读取放大、解析失败与后续过滤/转换。

Qoder Trace 使用同一字段契约，但一期只统计产生事件的主 Hook JSONL；segment、intercept 和 SQLite 扩展读取不会混入 `source_kind=primary`。

## 覆盖边界

- 已覆盖继承公共 `BaseHookInput` 和 `BaseSessionInput` 且未重写读取流程的 Input；
- 已显式覆盖 `qoder-trace` 主 Hook JSONL；
- 已显式覆盖 `codex-transcript`：正常消费计入 `raw_in_*`，边界查找、恢复和元数据回读只计入实际发生的 `raw_read_*`；
- `dsh-log`、`qoder-work-log`、`qoder-work-trace` 等重写了公共读取流程的 Input 暂不误报原始读取量，后续需要分别接入；
- 不新增或修改 `pilot_trace_runtime`，不负责 session/turn 缓存、生命周期、异常或释放明细。

## Codex Hook 调用耗时（`type=hook`）

Rust 的 Codex Hook 在写出并刷新 `{}` 响应后，用单调时钟固定本次原生处理耗时，再将无正文的样本追加到 `<dataDir>/state/hook-metrics/codex.jsonl`。时间从进入原生 Hook 处理函数开始，包括 stdin 读取、上下文和唤醒标记处理；不包含进程启动、包装脚本、指标落盘及退出时间，也不是异步 transcript 采集耗时。与 main 的 Node 指标协议兼容，但耗时度量的是 Rust 处理阶段。

collector 在启动、每 10 分钟和正常退出的 L2 周期消费样本，按 `agent + hook_event` 汇总，发送到既有 `pilot_pipeline`，并镜像到 `logs/metric_alarm/pilot-hook-metrics-YYYY-MM-DD.jsonl`。行使用 `type=hook`，沿用 `hostname`、`ip`、`instance_id`、`run_id`、`user_id`、`window_ms` 和 `__time__`。开源版只保留本地镜像；集团版沿用已配置的内部自监控 sender。

- `calls`：本次消费的有效调用样本数；忽略事件和处理失败的调用运行到采样点时也计入，不表示采集成功。
- `total_duration_ms`：有效调用耗时总和，毫秒；平均耗时用总耗时除以总调用数。
- `max_duration_ms`：最慢一次调用的毫秒数。
- 没有样本的事件不产生空行；有效的零毫秒调用仍计数。

生产者最多等待文件锁 50 毫秒，活动文件最多 1 MiB；写入失败、锁竞争或文件满只丢弃指标样本。这个等待预算不是文件系统调用或整个 Hook 的硬超时。消费使用同一空文件锁，将活动文件移到 `.draining`；先恢复已有待处理文件，读取或删除失败时保留重试，禁止覆盖未消费样本。每轮最多 64 个 Agent/事件组合，非法样本和超过一天的耗时被丢弃；样本协议没有时间戳，一天不是样本年龄限制。

该指标是 best-effort 自监控，进程崩溃或远端发送失败不保证重放。积压样本归入下一次消费窗口，`window_ms` 是 collector 上报间隔，不能用启动短窗口推算积压调用发生速率。本地文件沿用 `metricAlarmDays` 和指标日志容量清理策略。
