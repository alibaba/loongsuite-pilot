## Why

定位持续高内存时，需要知道现有 Trace 待转换缓存中哪个 Agent、哪个 turn 最大。2026-09-04 方案复核后，以低风险、少量计数优先，接受时间关联和采样缺失，不再追求完整的逐 turn 读取到导出归因。

## What Changes

- 复用已计算事件字节，只在现有 OTLP turn buffer 增加逻辑字节、未计量记录数和创建时间。
- 按 Agent 累计移出缓存的次数/字节，以及同步转换器调用次数、耗时和失败数。
- 在既有十分钟状态上报周期发送 `pilot_trace_runtime` 的 `schema_version=2, record_type=snapshot`；携带同一进程身份及最大待转换缓存的 turn/session 标识。
- 删除独立 Observer、源读取关联、阈值/明细队列、逐 turn 内存采样和独立定时器；恢复原有输入读取、解析、转换/导出与退出顺序。

## Capabilities

### New Capabilities

- `trace-runtime-observability`: 少量缓存计数、同步转换计时和周期快照。

### Modified Capabilities

无。

## Impact

只涉及 InputManager 已有字节结果的保留、flusher 的数字参数与快照、现有 MetricsWriter 上报入口。不修改输入源、MetricsCollector 身份生成、用户配置、依赖、事件内容或公共使用文档。旧方案尚未合入，本次直接以精简规格替换，不保留旧明细协议。
