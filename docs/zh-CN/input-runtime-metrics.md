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

Codex 的 `session-start`、`user-prompt-submit`、`subagent-start`、`subagent-stop` 和 `stop` Hook 在写出 `{}` 后，用单调时钟固定本次 Node 处理部分的耗时，再受保护地加载可选计时模块。模块缺失、解析或初始化失败不影响已有上下文和唤醒处理。计时从 Node 的 `performance.timeOrigin` 开始，包含业务模块加载、stdin 读取、上下文和唤醒标记处理；不包含 Bash/PowerShell 包装脚本的启动、Node 查找及版本探测，也不包含可选计时模块加载、计时样本落盘和进程退出。因此它是 Hook 的 Node 部分耗时，不是宿主观察到的完整 Hook 延迟，更不是异步 transcript 采集耗时。

Hook 只在 `<dataDir>/state/hook-metrics/codex.jsonl` 追加无正文的耗时样本，不发起网络请求。collector 在现有 L2 周期（启动、每 10 分钟、正常退出）消费样本，按固定的 `agent + hook_event` 聚合：

- 远端复用 `pilot_pipeline`，行的 `type` 为 `hook`，沿用每行的 `hostname`、`ip`、`instance_id`、`run_id`、`user_id`、`window_ms` 和 `__time__`；
- 本地镜像写入 `logs/metric_alarm/pilot-hook-metrics-YYYY-MM-DD.jsonl`，沿用 `metricAlarmDays` 保留和指标日志容量清理；
- 当前只有 Codex Hook 生产耗时样本；没有样本的事件不生成零调用、零耗时行；忽略事件和处理失败的调用只要运行到采样点也会计入，不代表采集成功；
- 开源版保留本地镜像，远端发送沿用现有空实现；集团版通过既有自监控 sender 上报，不新增服务端地址或配置。

| 字段 | 聚合方式 | 含义 |
|------|----------|------|
| `agent` | 维度 | 固定为 `codex`。 |
| `hook_event` | 维度 | Hook 子命令，例如 `stop`、`user-prompt-submit`。 |
| `calls` | 求和 | 本次消费到的有效调用样本数，不是会话数、标准事件数或成功采集次数。 |
| `total_duration_ms` | 求和 | 有效调用的 Node 部分耗时总和，单位毫秒。 |
| `max_duration_ms` | 最大值 | 有效调用中最慢一次的 Node 部分耗时，单位毫秒。 |

例如两次 `stop` 调用分别耗时 40 ms 和 120 ms，明细字段为：

```json
{
  "type": "hook",
  "agent": "codex",
  "hook_event": "stop",
  "calls": "2",
  "total_duration_ms": "160",
  "max_duration_ms": "120"
}
```

查询平均耗时使用 `SUM(total_duration_ms) / SUM(calls)`；最慢调用使用 `MAX(max_duration_ms)`，不要对窗口平均值再做简单平均。

耗时统计是 fail-open 自监控：每次调用都尝试记录，没有配置采样率；锁竞争等待预算为 50 ms，每个 Agent 的活动样本文件最多 1 MiB，一次消费最多输出 64 个 Agent/事件组合。写出 `{}` 不代表进程已退出，可选模块加载、同步等锁和落盘仍会延迟 Hook 退出；50 ms 不是整个记录函数或文件系统操作的硬超时。写入失败、锁竞争、文件满、非法样本或未运行到采样点的进程会缺少样本，不能以 `calls` 推断全部真实调用数。collector 用同一文件锁将样本文件移到 `.draining` 后消费，异常退出留下的 `.draining` 可在下次恢复；远端发送失败不保证重放。

collector 停机或锁竞争期间积压的样本归入下一次消费窗口。`window_ms` 表示 collector 的本次上报间隔，不保证所有 Hook 都发生在该时间段内，尤其不能用启动短窗口计算积压调用的每秒调用率。
