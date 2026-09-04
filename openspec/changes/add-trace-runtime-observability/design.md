## Context

这是 2026-09-04 用户确认的精简方案，替代本变更原有完整归因设计。允许不精确，但不能为了统计引入额外业务处理流程。

## Decisions

1. **复用缓存本身**：`TurnBuffer` 增加 `logicalBytes`、`unmeasuredRecords`、单调创建时间和 Agent 计数器引用。没有第二份 turn Map；记录数读取 `records.length`，快照不遍历记录。
2. **复用现有序列化**：InputManager 在原有序列化循环中保留数字数组，按原顺序传给 flusher。无第二次序列化，无逐行源读取对象，无输入侧改动。数组缺失、长度错配或非有限/负数字记为未计量记录，不拒绝业务数据。
3. **累计值不重置**：每个 flusher 最多维护 64 个 Agent 的固定数量标量。更多 Agent 不创建诊断维度，业务照常处理。累计字段在进程生命期内不清零，查询用相邻样本差值；空闲不会拉长或错位一个独立统计窗口。
4. **仅待转换缓存**：`pending_*` 只反映原有 `turnBuffers`。移出 Map 的位置累计 `removed_*`，不等待导出完成。移出不是垃圾回收，正在转换/导出的对象不在快照范围内；快照无法覆盖两次采样之间完成的短 turn，也不表明哪个 turn 独占进程内存。
5. **只测同步转换器**：`converter_*` 在现有 `convertEventLogToTrace` 同步调用及其标识清理周围更新。排除等锁、`await forceFlush` 和网络导出。不同 serviceName 的真实重复转换分别累计，不计算跨异步分支的结果或墙钟区间。
6. **复用既有上报**：MetricsWriter 在已有 L1 十分钟周期取快照，原样复用该 L1 的 `version/run_id/instance_id/user_id/__time__`。无新定时器/明细队列/进程内存采样/身份生成器；恢复 main 的停机顺序，接受最后导出阶段没有独立最终报告。
7. **复用现有输入指标**：当前 main 的 `raw_read_bytes/raw_in_bytes` 按输入组件记录读取/输入量，与进程状态和本主题按身份、时间关联。不为精确 turn 归因新增匹配、等待或补偿。

## Snapshot fields

- 固定：`schema_version=2`、`record_type=snapshot`、`buffer_scope=pending_conversion`。
- 维度：`agent_type` 及上述进程身份。
- 当前：`pending_buffers/records/logical_bytes/unmeasured_records`。
- 最大/最老：`largest_buffer_logical_bytes/records/age_ms/turn_id/session_id`、`oldest_buffer_age_ms`。最大按已知逻辑字节选取，未计量记录存在时大小不完整。
- 累计：`removed_buffers_total/removed_logical_bytes_total/removed_unmeasured_records_total`、`converter_calls_total/converter_duration_ms_total/converter_failed_total`。

逻辑字节是脱敏展开后事件的 UTF-8 JSON 大小，不是原始输入大小或真实对象内存。ID 只取现有缓存标识，不采正文。开放缓存的数量限制沿用 main（当前实现可暂存 65 个），本变更不调整它。

## Verification

覆盖字节对齐、最大/最老缓存、批内提前移出、缺失测量、累计值不重置、Agent 维度上限、双 serviceName/等锁计时、转换失败和上报失败隔离。使用相同数据对比 main 与修改后完整 InputManager → MultiFlusher → OTLP 转换链路的输出摘要、CPU、耗时、峰值内存；不以局部计数器测试替代整条链路开销验证。
