## Why

线上只能观察到 Pilot 进程内存、CPU 与各 Agent 输入总量的时间相关性，无法确认高资源占用来自某个长期未结束的 turn、多个短 turn、事件构造放大，还是 Trace 转换与导出。需要增加一条低开销、可关联到具体 Agent、会话和 turn 的运行诊断证据链，才能把内存与 CPU 告警从推测推进到可验证的定位。

## What Changes

- 新增内部运行诊断主题 `pilot_trace_runtime`，用 `window` 和 `turn` 两类记录连接“原始读取 → 事件生成 → turn 缓存 → Trace 转换与导出 → 缓存释放”。
- 每十分钟按 `agent_type + input_name` 上报 `window` 汇总，包含输入与事件字节、当前缓存、最大活跃 turn、已完成 turn 的大小分布、转换与导出耗时和失败数；正常小 turn 只进入汇总，不逐 turn 上报。
- turn 缓存跨过 64 MiB、256 MiB、1 GiB，存活时间跨过 30 分钟、2 小时，或发生强制释放、空闲超时、未完成退出、保护性释放、转换失败、导出失败时，上报带 `user_id`、`session_id`、`turn_id`、`trace_id` 的 `turn` 明细；跨过阈值的 turn 在最终释放时再上报完整结果。
- 在输入到输出的批次调用中传递仅供运行时使用的上下文，包括 `input_name`、逐事件已计算的逻辑字节数，以及输入源可提供时的原始读取字节；不把这些字段写入 `AgentActivityEntry`。
- 在公共 OTLP Trace 组件中以常数时间维护每个 turn 的记录数、逻辑字节水位、峰值和阶段耗时，使 Codex、Qoder 及其他采用“按 turn 缓存后构造 Trace”的 Agent 共用同一套结构。
- 复用现有序列化字节结果，只在阈值、异常和最终释放等低频节点读取进程 RSS 与 JavaScript 堆；禁止为诊断遍历或重新序列化整个缓存、重读 transcript、生成堆快照或开启 CPU profile。
- 该变更只增加观测能力，不新增告警规则，也不改变 turn 边界、缓存释放、转换或导出行为。

## Capabilities

### New Capabilities

- `trace-runtime-observability`: 定义 `pilot_trace_runtime` 的两类记录、字段语义、明细触发规则、低开销约束、输入字节归因和跨 Agent 复用要求。

### Modified Capabilities

<!-- None. openspec/specs/ 当前没有已发布 capability；本变更不修改 AgentActivityEntry 或现有 signals-trace 行为契约。 -->

## Impact

- **核心数据流**：`src/core/input-manager.ts` 需要保留逐事件已计算字节数，并将输入身份和可选原始读取量作为批次上下文传给输出层。
- **输出接口**：`src/flushers/base-flusher.ts` 与 `src/flushers/multi-flusher.ts` 需要支持可选批次上下文并原样扇出；现有 flusher 可忽略该上下文。
- **Trace 运行态**：`src/flushers/otlp-trace-flusher.ts` 需要维护通用 turn 水位、生命周期、转换与导出结果，并向独立的运行诊断汇总器发送轻量更新。
- **指标上报**：`src/metrics/metrics-writer.ts`、`src/metrics/metrics-collector.ts` 或一个由其持有的专用组件需要生成十分钟 `window` 记录，并发送有界、去重后的 `turn` 明细到 `pilot_trace_runtime`。
- **输入源**：`src/inputs/codex-transcript/` 和 `src/inputs/qoder-trace/` 首批提供可用的原始读取字节归因；其他输入源可以以后按同一可选接口接入。
- **外部接口与依赖**：不改变用户配置、AgentActivityEntry、OTLP Trace 内容或外部依赖；新增的是 Pilot 内部批次上下文与运行诊断记录格式。

### Affected Baseline Modules

- Core / Input：输入批次从 `InputManager` 到 flusher 的上下文传递。
- Flushers / Trace：公共 turn 缓存、转换和多目标导出的运行态观测。
- Metrics / Monitor：十分钟窗口聚合、明细事件排队和内部主题上报。
- 当前 checkout 中 `docs/constitution.md` 与 `docs/modules/*.md` 缺失；现有可核对文档为 `docs/overview.md`、`docs/trace-input-development-guide.md` 和 `docs/trace-output.md`。

### Baseline Modification

本变更增加内部批次上下文和 Trace 运行诊断职责，属于数据流与模块责任的扩展。实现完成后，需要在人工确认下补齐或更新 Core/Input、Flushers/Trace、Metrics/Monitor 的 baseline 描述；`docs/ai_event_schema.md` 不需要修改，因为运行诊断字段不会进入 `AgentActivityEntry`。
