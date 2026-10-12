# Hermes / OpenClaw 子 Agent Trace

已确认派生关系的子 Agent 与发起工具使用同一 Trace，结构为
`主 AGENT → 派生 TOOL → 子 AGENT → STEP → LLM/TOOL`。
子运行保留自己的 `gen_ai.session.id` 和 `gen_ai.turn.id`，不额外生成 ENTRY。
父子各自按原生命周期导出，不等待所有后台任务结束，不延长工具时间，也不将子 Token 重复累加到父 Agent。

## 关联来源

- OpenClaw：在 `before_tool_call` 保留工具 Span ID，通过 `sessions_spawn`
  返回的 `details.runId`（或直接结果的 `runId`）与子运行精确关联。
  子运行早于返回值产生的事件暂存，内容关闭时先去掉内容再暂存。
  每个子运行最多暂存 512 条 / 4 MiB / 30 秒，超限则独立导出并标注
  `agent.openclaw.subagent.collection=parent_unresolved`，不猜测父级。
  独立导出后不会再修改该运行的 Trace；后续成功关联不能回写已上报数据。
- Hermes：Hook 没有提供父工具 ID，因此插件对原生
  `tools.delegate_tool._build_child_agent` 做小范围兼容适配，在子对象创建后、
  提交到线程之前保存父会话、当前委派调用及工具 Span ID。
  仅关联与执行上下文中 session/turn/call 精确匹配、尚未结束的委派工具。
  支持该入口下的单个、批量并行及后台子运行；缺失该入口的版本仍正常采集，
  但不能据此声称支持父子关联。插件更新后须完全重启 Hermes。

这不是按任务文本或时间窗口拼接。用户身份来自已确认的派生关系；Hermes
仍保留显式 invocation/environment 身份优先级。子任务缺少 sender 时可继承发起用户，
不能用同会话“最近一个用户”兜底。

两种插件将不含 Prompt 的关联元数据保存到
`$PILOT_DATA/subagent-contexts/{hermes,openclaw}/`，文件为 0600，使用原子替换。
OpenClaw 按原生 runId、Hermes 按子 sessionId 查询，可跨采集器重启恢复。
关联记录有效期为 7 天；Hermes 创建关联时清理过期记录，OpenClaw 每个插件进程首次创建时清理。OpenClaw 未匹配的早期事件
暂存在 Agent 进程内；该进程在建立关联前崩溃可能丢失这些暂存事件。

## 边界

- OpenClaw 当前适配 `sessions_spawn` 的 subagent 运行；不宣称 ACP 外部运行时已支持。
- 自动通知/结果回传可以创建新的顶层 turn。本实现不将所有后续 turn 强制合并到旧 Trace。
- 跨主机且不共享 Pilot 数据目录的运行，需要显式传播上下文，不能靠本地关联文件完成。
- 同 Trace 不要求子时间段落在父工具时间段内：后台任务可晚于派生工具结束。
  校验异步结构时必须保留这一语义，不能人为拉长工具耗时。
- OpenClaw 既有插件逻辑会将推算的工具结束时间裁剪到观测时间或下一模型调用开始时间，
  同时保留原生 `durationMs` 和裁剪标记；本变更未调整该行为，不宣称 Span 时长与原生 duration 毫秒级一致。
- Trace 根入口仍只统计一次，但业务调用次数及用户用量查询须采用明确的统计口径；
  不应同时对 AGENT 汇总值和 LLM 明细求和。

## 复用依据与验证

沿用 Pilot `SpanIdReservations`，保证 JSONL 工具 ID 与最终 OTLP 工具 Span ID 一致；
参考 `qwen-subagent-converter.ts` 的透明子 ENTRY，使用公共转换器生成各自的子树。
对齐 LoongSuite Python Hermes `RunConversationWrapper` / `ToolCallWrapper`
及 `test_agent_features.py` 的 `delegate_task → invoke_agent` 断言。
这里对齐的是父子拓扑语义，未验证与 Python 探针同时启用；不要因此推断双重采集不会产生重复 Span。

验证包括原生父子标识、不同用户并行、异步晚到、无 `other` 输入事件、重启后读取关联、
内容关闭、原生异常不受影响、唯一 Span ID、真实父 Span 存在、逐 LLM Token 不重复。
实际 Agent 版本及安装产物、云端验收状态应随每次发布记录，不以这些源码断言代替 E2E。

## 本次安装态验证（2026-10-10）

- Hermes 0.19.0（本机源码 64702f8f）与 OpenClaw 2026.7.1-2：
  各派发两个子任务，包括读取存在/不存在的文件；实际执行调度由原生运行时决定。
  最终子 AGENT 均与发起 TOOL 同 Trace，准确指向实际工具 Span ID；
  每条派生 Trace 一个 ENTRY，原生 session 保留、用户继承、逐 LLM Token 与源事件一致。
- 关闭内容采集时另跑真实子任务，确认 JSONL 与导出 Span 均无消息、工具参数/结果和测试内容标记。
- 首轮本地 OTLP HTTP 接收端解码确认发送的真实 Span；后续云端补验见下节，控制台 UI 尚未验收。
- 旧通用 Trace 校验器要求单 AGENT、统一 session、全局步骤不重叠、
  时间完全包含及父 AGENT 包含所有后代 Token，故不适配本方案。
  专项测试按精确父工具、异步生命周期和每个 Agent 自身用量断言；旧规则的 FAIL 仍保留。
  旧 strict JSONL 校验器还不识别 OpenClaw 已有的 `agent.input` 事件；
  Hermes strict JSONL 通过。发布前须协调这些校验及展示/统计口径。

## ARMS/CMS 安装态前后对比补验（2026-10-10）

使用准确基线 94cb9d43 与本分支候选分别构建、安装，保持上述真实 Agent 版本与双子任务场景一致，
两侧均向杭州 default ARMS/CMS 上报并完整回读。

| Agent | 基线核心任务 | 候选核心任务 |
| --- | --- | --- |
| Hermes | 3 Trace / 3 ENTRY / 21 Span | 1 Trace / 1 ENTRY / 19 Span |
| OpenClaw | 3 Trace / 3 ENTRY / 23 Span | 1 Trace / 1 ENTRY / 21 Span |

核心任务包含父任务与两个子任务，不含自动结果回传的新顶层轮次。
计入结果回传后，两侧共 106 个 Span，全部从云端查回，与本地 Span ID 集合、父级、用户和逐 LLM Token 一致。
候选的两个子 AGENT 均指向真实派生 TOOL；移除的是两个多余子 ENTRY，没有减少 LLM 或工具。

这是云端 API 回读验收，尚未验证浏览器控制台展示。旧通用规则的不适配仍保留为 FAIL，
专项父子拓扑/送达断言单独 PASS；不以云端有数据代替其他语义验收。原始证据和账号信息私下保管。
