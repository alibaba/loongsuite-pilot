## Context

Pilot 已经分别具备三类数据，但它们之间缺少同一个 turn 维度的连接：

1. `pilot_status` 有进程级 RSS、JavaScript 堆和 CPU；
2. 输入指标有按 Agent 汇总的事件数与字节数；
3. `OtlpTraceFlusher` 在进程内按 turn 保存完整 `AgentActivityEntry[]`，结束后再转换并导出 Trace。

因此，当前数据只能说明“某段时间 Codex 输入高且进程内存高”，不能说明具体是哪一个 turn 在增长、缓存了多少事件、存活多久、何时释放，也不能区分增长发生在输入读取、事件生成、turn 缓存还是 Trace 转换阶段。

当前实现还有三个直接约束：

- `InputManager` 已经序列化事件来计算字节数，但只把事件数组传给 `BaseFlusher.sendBatch()`；若在 Trace flusher 中再次序列化整个缓存，会引入与被调查问题同方向的额外 CPU 和内存开销。
- `OtlpTraceFlusher` 最多保留 64 个开放 turn，但单个 turn 的 `records` 没有字节上限；运行诊断必须观察现有行为，不能暗中改变 turn 边界或释放策略。
- 内部状态通过 `sendStatus()` 发往 `loongsuite_status`；开源构建中的对应方法是空实现。新主题应沿用这条边界，不进入用户的业务事件或 OTLP Trace。

仓库的 baseline 指南引用了 `docs/constitution.md` 和 `docs/modules/*.md`，但当前 checkout 中这些文件不存在。本设计依据当前代码以及 `docs/overview.md`、`docs/trace-input-development-guide.md`、`docs/trace-output.md`，并把 baseline 补充保留为最后的人工确认任务。

## Goals / Non-Goals

**Goals:**

- 用 `pilot_trace_runtime` 建立从原始读取量到 turn 缓存、转换、导出和释放的可查询证据链。
- 能按 `version`、`run_id`、`instance_id`、`user_id`、`agent_type`、`input_name`、`session_id`、`turn_id` 和 `trace_id` 关联现有告警与状态数据。
- 正常情况只产生十分钟汇总；大 turn 和异常情况产生有限、去重的明细。
- Codex 和 Qoder 首批接入，公共 OTLP turn 缓存使其他采用相同模式的 Agent 可以复用。
- 热路径只做整数加减、数组下标访问和读取单调时钟；不为了指标扫描事件内容或复制缓存。

**Non-Goals:**

- 不根据这些指标直接新增或调整内存、CPU 告警规则。
- 不新增 turn 字节上限，不改变现有强制释放、边界判断、转换和导出语义。
- 不证明某个 turn 独占了多少 RSS 或 JavaScript 堆；进程内存只作为同一时间点的相关证据。
- 不采集用户输入、模型输出、工具输出、文件内容、堆快照或 CPU profile。
- 不改变 `AgentActivityEntry`、OTLP Span 或用户配置格式。

## Decisions

### D1. 使用独立的内部运行诊断主题

所有记录发送到 `loongsuite_status` 的 `pilot_trace_runtime` topic，并带 `schema_version: "1"`。它不经过 `MultiFlusher`，也不写入 `AgentActivityEntry` 或用户配置的 SLS/JSONL/HTTP/OTLP 目标。

原因是这些字段描述 Pilot 自己如何处理事件，而不是 Agent 的业务行为。独立主题还允许对 turn 标识设置单独的查询权限和保留周期。

备选方案是把字段加到每条 `AgentActivityEntry`。该方案会放大所有输出目标的数据量，使运行诊断字段进入客户数据面，并且仍然无法表达释放后的汇总结果，因此不采用。

### D2. 用可选批次上下文传递现有字节结果

在 flusher 内部接口增加可选上下文，概念结构如下：

```ts
interface FlusherBatchContext {
  inputName: string;
  entryLogicalBytes: readonly number[]; // 与 entries 按下标一一对应
  sourceReads?: readonly SourceReadMeasurement[];
}

interface SourceReadMeasurement {
  agentType: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  bytes: number;
  basis: 'bytes_read' | 'offset_delta';
}
```

`InputManager` 将当前计算 `outputBatchBytes` 的序列化过程改为一次遍历，同时保留逐事件字节数组和总和；现有计数器继续使用总和，`MultiFlusher` 把上下文原样转发，其他 flusher 可以忽略它。数组长度或下标不匹配时，Trace 运行诊断跳过该批的逻辑字节归因并记录内部警告，正常输出不失败。

原始读取量不是用事件 JSON 大小冒充。输入源可以在已有读取循环中提供 `SourceReadMeasurement`：文件整体读取使用实际 `bytesRead`，严格尾读使用已消费 offset 差值。没有可靠 turn 标识的读取只进入窗口的未归因字节，不进入具体 turn。

备选方案是在 `OtlpTraceFlusher` 中重新 `JSON.stringify()` 每条事件或整个 turn。它会重复热点开销，且大 turn 越严重，诊断本身越重，因此禁止。

### D3. 由独立 `TraceRuntimeObserver` 保存轻量状态

新增进程内 `TraceRuntimeObserver`，由 Orchestrator 创建并注入 `InputManager`、`OtlpTraceFlusher` 和 `MetricsWriter`。它只保存标识、计数器、阈值位图和时间戳，不持有 `AgentActivityEntry`、Span 或用户内容。

数据流为：

```text
Input source ── sourceReads ─┐
InputManager ─ entry bytes ──┼─> OtlpTraceFlusher ─ append/release/convert/export ─> TraceRuntimeObserver
                             └───────────────────────────────────────────────────────┘
MetricsWriter ── 30 秒明细排空 / 10 分钟窗口快照 ──> pilot_trace_runtime
```

`OtlpTraceFlusher` 仍然是 turn 生命周期的事实来源。Observer 使用 flusher 提供的稳定进程内 buffer key 关联更新，避免自己重新推断 turn 边界。这样既不会出现两套边界逻辑，也不需要遍历 flusher 的 `records`。

备选方案是把所有计数器直接堆进 `MetricsWriter`。它不了解 turn append、转换和导出的准确时点，会迫使 flusher 暴露可变内部状态，因此不采用。

### D4. 运行身份只生成一次并与现有状态主题一致

把现有 `MetricsCollector` 中的 `instance_id` 和 `run_id` 生成逻辑提取为共享的只读运行身份，由 Orchestrator 同时传给 `MetricsCollector` 和 `TraceRuntimeObserver`。所有 `pilot_trace_runtime` 记录还带 `version`、`user_id` 和 `__time__`。

- `instance_id` 跨进程重启稳定，用于关联同一个安装实例；
- `run_id` 每次进程启动变化，用于区分重启前后的缓存；
- `version` 允许直接比较不同 Pilot 版本，无需依赖时间区间反推版本。

不复用 `OtlpTraceFlusher` 当前仅供 OTLP Resource 使用的随机 `instanceId`，否则同一进程的 `pilot_status` 与 `pilot_trace_runtime` 无法精确关联。

### D5. turn 水位用常数时间增量维护

一个活跃 turn 的观测状态至少包含：记录数、当前逻辑字节、峰值记录数、峰值逻辑字节、首次和最近活动单调时间、原始读取字节、生成事件字节、已触发阈值位图，以及 session/turn/trace 标识。

每次 append 使用 `entryLogicalBytes[index]` 做加法并更新峰值；释放时使用已维护的当前值做减法或清零。不得为了计算水位遍历 `records`。生命周期使用单调时钟，避免系统时间调整造成负数或跳变；上报时间仍使用 Unix 时间。

内存阈值固定为 64 MiB、256 MiB、1 GiB，生命周期阈值固定为 30 分钟、2 小时。一次 append 跨过多档时，每档各产生一次 `threshold_crossed` 记录。生命周期由 30 秒诊断周期检查轻量元数据；最多扫描现有的 64 个开放 turn，不访问事件数组。

这些阈值只控制明细量，不触发告警和释放，可以在不改变 schema 的情况下调整常量。

### D6. `window` 是按 Agent 与输入组件分组的十分钟窗口

`record_type=window` 每十分钟按 `agent_type + input_name` 生成一行，并在优雅退出时补发包含数据或活跃 turn 的不足十分钟窗口。字段分为四组：

- 身份与时间：`schema_version`、`version`、`run_id`、`instance_id`、`user_id`、`agent_type`、`input_name`、`window_ms`、`__time__`；
- 流量：`source_bytes_total`、`source_bytes_unattributed`、`produced_event_count_total`、`produced_event_bytes_total`；
- 当前缓存：`active_turn_count`、`buffer_records_current`、`buffer_logical_bytes_current`、`largest_active_session_id`、`largest_active_turn_id`、`largest_active_trace_id`、`largest_active_turn_logical_bytes`、`oldest_active_turn_lifetime_ms`；
- 已完成：`completed_turn_count`、`released_logical_bytes_total`、`completed_turn_logical_bytes_max`，以及 `completed_turn_le_1m_count`、`completed_turn_1m_to_16m_count`、`completed_turn_16m_to_64m_count`、`completed_turn_64m_to_256m_count`、`completed_turn_256m_to_1g_count`、`completed_turn_gt_1g_count` 六档计数；
- 阶段结果：`converted_span_count_total`、`convert_attempt_count`、`convert_duration_ms_total`、`convert_duration_ms_max`、`convert_failed_count`、`export_turn_count`、`export_duration_ms_total`、`export_duration_ms_max`、`export_failed_turn_count`、`detail_dropped_count`。

窗口指标在生成记录后排空，当前缓存字段是快照而不是增量。即使所有 turn 都很小，也能从分布和总量看到正常基线。

`source_bytes_total` 包含该窗口可归因与不可归因的全部真实读取量，`source_bytes_unattributed` 是其中无法可靠分到具体 turn 的子集。`export_turn_count` 按 turn 计数，不因配置了多个导出目标而倍增。

进程 RSS、堆和 CPU 不在窗口中重复采集；通过相同 `run_id + instance_id` 和相邻 `__time__` 与 `pilot_status` 关联。

### D7. `turn` 明细只记录阈值、异常和重要最终释放

`record_type=turn` 有两种事件：

- `event=threshold_crossed`：除公共身份和 session/turn/trace 标识外，记录 `threshold_kind`、`threshold_value`、`lifetime_ms`、`source_bytes_total`、`source_bytes_basis`、`produced_event_bytes_total`、`buffer_records_current`、`buffer_logical_bytes_current`、`peak_buffer_records`、`peak_buffer_logical_bytes`、`rss_bytes` 和 `heap_used_bytes`；无法归因或尚未产生的可选字段省略；
- `event=released`：除公共身份和 session/turn/trace 标识外，记录 `release_reason`、`boundary_signal`、`lifetime_ms`、`source_bytes_total`、`source_bytes_basis`、`produced_event_bytes_total`、`peak_buffer_records`、`peak_buffer_logical_bytes`、`released_logical_bytes`、`converted_span_count`、`convert_duration_ms`、`export_duration_ms`、`rss_before_convert_bytes`、`rss_after_convert_bytes`、`heap_used_before_convert_bytes`、`heap_used_after_convert_bytes` 和 `result`；未执行阶段的字段省略。

明细触发规则如下：

- 每个 turn 的每个大小档和生命周期档最多记录一次；
- 强制释放、空闲超时、进程退出时仍未完成、超过现有保护上限、转换失败或任一导出目标失败，无条件记录最终 `released`；
- 曾跨过任一阈值的 turn 最终释放时记录 `released`；
- 未跨阈值且正常成功释放的小 turn 不产生明细，只进入 `window`。

`export_duration_ms` 是从该 turn 开始导出到所有目标完成或失败的墙钟耗时，不把并行目标的耗时相加。任一目标失败时 `result=export_failed`；转换未完成时 `result=convert_failed`；其余为 `success`。

首版 `release_reason` 取值为 `terminal`、`group_successor`、`idle_timeout`、`buffer_limit`、`shutdown_incomplete` 或 `forced`。`boundary_signal` 保留真正触发边界的稳定代码，例如 `codex.task_complete`、`finish_reason.stop`、`group_key_change`、`turn_idle_timeout`、`max_turn_buffers` 或 `process_shutdown`，不写自由文本错误内容。

### D8. 字节字段区分处理压力与真实内存

- `source_bytes_total` 是 Pilot 为该 turn 实际读取或消费的源字节；重复扫描造成的重复读取会重复计数，因为它确实产生 CPU 和内存压力。
- `source_bytes_basis` 表明依据是 `bytes_read` 或 `offset_delta`。无法可靠归因时，turn 明细省略这两个字段，窗口把字节计入 `source_bytes_unattributed`。
- `produced_event_bytes_total`、`peak_buffer_logical_bytes` 和 `released_logical_bytes` 使用脱敏并展开后的事件 UTF-8 JSON 字节数，是逻辑处理量，不等于 V8 对象真实占用。
- `released_logical_bytes` 表示本次从 turn 缓存生命周期中移除的逻辑字节；完整释放通常等于释放前的当前逻辑字节。

这些定义允许计算“事件构造放大比例”，但查询和汇报必须同时说明逻辑字节不等于堆内存。

### D9. 内存与阶段耗时在真实边界采集

转换开始前读取 `process.memoryUsage()`，得到 `rss_before_convert_bytes` 与 `heap_used_before_convert_bytes`；转换完成并取得 Span、清空转换器临时缓冲后，立即读取 after 值。导出耗时单独测量。

如果转换抛错，仍记录失败后的内存样本；如果 turn 在进入转换前被直接丢弃或释放，不伪造转换字段。阈值事件只读取一次当前 RSS/堆。所有阶段计时使用单调时钟。

不使用 RSS 差值推导“该 turn 独占内存”，因为同一进程内还有输入、其他 turn、导出器和垃圾回收活动。

### D10. 明细使用有界队列并与主数据流隔离

Observer 把 `turn` 记录放入最多 1024 条的进程内队列，MetricsWriter 每 30 秒排空，优雅退出时再排空一次；`window` 每十分钟直接生成。阈值位图先去重，再进入队列。

队列满时丢弃最旧记录并递增 `detail_dropped_count`，该计数进入下一条 `window`。发送、格式化或队列异常只记录警告，不阻塞输入、Trace 转换或导出。由于 `sendStatus()` 没有确认语义，本能力提供诊断而不承诺可靠投递。

备选方案是在 append 热路径同步上报。它会把内部网络延迟带进 Agent 数据处理链，因此不采用。

### D11. Codex、Qoder 与后续 Agent 共用相同观测结构

公共 turn 状态从事件中的 `gen_ai.agent.type` 和批次上下文中的 `inputName` 得到维度：

- Codex：`agent_type=codex`，`input_name=codex-transcript`；
- Qoder Trace：`agent_type=qoder`，`input_name=qoder-trace`；
- 其他进入同一 `OtlpTraceFlusher` turn 缓存的 Agent 自动获得事件逻辑字节、缓存、转换和导出指标；只有需要 `source_bytes_total` 时才补充输入源的轻量测量。

首批支持的输入路径保证一个 turn 只由一个 `input_name` 提供。若未来允许同一 turn 跨多个输入源，必须先扩展归因契约，不能静默把所有读取量归给第一个输入。

### D12. 标识可关联，正文不可进入运行诊断

允许原样上报 `user_id`、`session_id`、`turn_id` 和 `trace_id`，以便从告警定位到具体用户和 turn。Observer 的类型和序列化白名单不得接受事件正文、输入消息、输出消息、工具参数、工具结果、文件路径或文件内容。

明细高基数字段只在阈值和异常事件出现；十分钟窗口只携带最大活跃 turn 的标识，不枚举所有 turn。

## Risks / Trade-offs

- **[逻辑字节与真实内存不成固定比例]** → 同时提供 RSS/堆边界样本，并在字段契约中禁止把逻辑字节解释为对象真实占用。
- **[原始读取量可能无法精确分到 turn]** → 只接受带关联标识的测量；无法归因的量进入 `source_bytes_unattributed`，不制造虚假的 turn 结论。
- **[观测器自己增加少量内存]** → 每个活跃 turn 仅保存常数个数字和标识，不保存记录；开放 turn 受现有 64 个上限约束，明细队列固定为 1024 条。
- **[进程硬崩溃可能丢失最近 30 秒明细]** → 采用低延迟周期排空和优雅退出排空；不为了诊断把同步 I/O 加入热路径。
- **[原始 ID 提高 topic 基数与访问敏感度]** → 只在需要关联的字段上保留 ID，禁止正文，并由内部状态 topic 的权限和保留策略管理。
- **[现有代码正在演进，接口改动可能与其他指标变更冲突]** → 批次上下文保持可选，现有 flusher 默认忽略；实现时基于当时主分支重新核对 `InputManager` 和 Metrics 计数语义。

## Migration Plan

1. 先加入共享运行身份、可选批次上下文和 Observer，保持现有 flusher 行为与输出不变。
2. 接入 OTLP turn append/release/convert/export 边界，并用单元测试验证计数、阈值去重、失败隔离和无额外序列化。
3. 接入 Codex 与 Qoder 的源读取字节测量；无法精确归因的路径明确上报为未归因。
4. 在内部构建发送 `pilot_trace_runtime`，先小流量检查 topic 量级、`detail_dropped_count`、进程 CPU/内存和字段完整性，再扩大范围。
5. 回滚时可整体停用 Observer 的注入和定时发送；批次上下文是可选的，不影响旧 flusher 或现有数据格式。
6. 代码验证完成后，经人工确认再补齐或更新受影响的 baseline 文档。

## Open Questions

无阻塞实施的问题。64 MiB、256 MiB、1 GiB 与 30 分钟、2 小时只作为首版明细采样阈值；上线后可根据真实分布调整常量，不改变字段格式。
