# Hermes 工作级委派审计

对应 [#486](https://github.com/alibaba/loongsuite-pilot/issues/486)。保留已有子会话和独立 Trace 生命周期，新增标准 invoke/result 与子工作 incoming；委派日志不增加 Span、STEP 或 token。

## 数据来源

- 在 `delegate_task` 的真实 pre-tool 边界，按每个 task index 生成独立且稳定的 invocation ID。单个 goal、批量任务和显式公共/单项 context 分别映射为 `gen_ai.input.messages`；list/steer/stop 控制操作不作为新委派。
- 复用 `_build_child_agent` 的精确父 session/turn/call 关系。身份元数据在提交子线程前落盘，并绑定实际 child 对象，避免同 session 的其他工作覆盖它。
- `_run_single_child` 将 incoming 限定在本次原生 worker 执行；同一工作跨子 turn 可以延续 incoming，旧子会话的自主输入不继承首次 invocation。嵌套 invoke 同时携带 incoming 和 outgoing。
- 同步 `post_tool_call` 的逐项 results 按原生 task_index 配对；后台 dispatched 只保存原生 delegation ID，不合成成功。支持 `units` 的逐组 task_indexes 和同步 inline results。
- 支持原生 `TimelineNotification.for_delegation` 的 CLI，可将结构化事件随字符串兼容通知传至实际接收工作的 `pre_llm_call`，此时才写 result，并采用实际接收 turn。只读取原生元数据，不解析任务文本或时间顺序。

新宿主会在隔离的 copy_context worker 中执行 Hook，回调中的 ContextVar 写入无法返回子工厂。兼容路径要求原生父 turn 精确相同，且仅存在一个未结束的 delegate call；有多个候选时保持独立采集，不猜测父级。旧的精确 ContextVar 路径优先。

## 持久化与边界

复用既有 `subagent-contexts/hermes`，以原子文件保存身份、工作定位和结果指纹，不额外保存任务正文。工作记录保留七天，扫描和容量有界。结果写入失败不确认去重，所有适配保持原生返回和异常行为。重试使用稳定 event ID，接收方仍需去重。

某些 gateway/跨进程后台回传会将结构化通知转成普通文本，无法取得本次实际结果的工作元数据和接收 turn；此类路径不保证生成 result。未提供可靠身份的复用/续作入口、并行歧义及缺少兼容方法的宿主应明确降级，不能声称完整支持。升级后须完全重启 Hermes 宿主，单独重启 collector 不会重新加载插件。

## 验证

合成回归覆盖批量隔离、嵌套 incoming/outgoing、隔离 Hook、同步成功/失败、后台受理与实际接收、重放去重、重启和自主输入。跨输出测试覆盖 JSONL、真实 localhost HTTP、SLS SDK 边界与脱敏；独立子轮次的 Span 挂载及 incoming 透传另行断言。

2026-10-20 使用官方源码 `5fc490e2`（显示 2026.9.24）、既有官方 CLI 和 `qwen-plus`，从候选安装包部署到独立原生 profile。真实批量子任务覆盖文件读取成功与失败，所有子事件保留自己的 session/turn 并携带匹配 incoming。宿主重新启动后验证最终候选，保留早先未重新加载插件时的失败证据。

最终候选产生 22 条规范事件（2 条 invoke、2 条 result），12 条子工作事件全部携带匹配 incoming；严格 JSONL validator 通过。真实事件经候选转换器和正式 OTLP exporter 发送至 localhost，解码后核对 19 个 Span 的 ID 集合及实际父工具。移除审计日志后的执行数量、时间和逐 LLM token 相同。该证据证明本次同步批量及本地导出；完整后台 gateway 矩阵、生产云端回读和控制台验收未执行。
