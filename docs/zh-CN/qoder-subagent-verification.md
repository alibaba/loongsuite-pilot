# Qoder 子 Agent 采集

> 适用版本：开源 [#586](https://github.com/alibaba/loongsuite-pilot/pull/586) 的 JS 实现。本文记录原生 sidechain 协议及验收口径，供 Rust 适配参考。Rust v2 仍待补齐子 transcript 发现、父子关系恢复及 Trace 关联。下文的验证命令适用于 JS 分支。

Qoder CLI 与 Agent SDK 的原生 sidechain 使用独立 transcript，同时可能与主 Agent 共用 `sessionId`。Pilot 保留原生 session，通过 `agentId` 区分执行者，并为每个原生输入建立独立、可恢复的 turn；不会把子执行覆盖成父 turn，也不会为共享 session 的运行时伪造子 session。

## 应用边界

本次实现针对 Qoder CLI 原生 sidechain；复用相同运行时与 Hook/transcript 协议的 SDK 或桌面封装可以共用此路径。QoderCN 的专属子 Agent Hook 和上游上下文接线不在本次改动范围内；共用读取/转换组件不代表已经支持 QoderCN。Qoder Work 不在本次改动范围内。

委派登记仅在 `qoder` 来源且原生记录 `entrypoint=cli` 时启用，避免 IDE 或 CN 主会话仅因调用同名 Agent 工具便进入这套 CLI 适配。

**Qoder IDE / QoderCN IDE 的独立子会话仍需额外适配。** 两者 1.37.0 的真实测试样本使用独立的子 `sessionId`，文件位于项目 `transcript/<childSessionId>.jsonl`，没有 CLI 的 `isDelegatedTask`、`parent_tool_use_id` 或初始用户输入；父工具的 `toolUseResult` 也可能是字符串。仅添加 `SubagentStart/Stop` 声明不足以让当前 CLI tailer 完整读取这些子执行。

IDE 的 SQLite `chat_session` / `chat_record` 已提供 `parent_session_id`、`parent_tool_call_id`，可作为精确关联依据；后续需要补充独立子会话发现、无初始用户行的执行边界及消息补全、按子 session 的模型用量读取，再复用现有委派模型与 Span 转换。此路径尚未实现，也未完成对应候选的 GUI/CMS 验收。

## 数据来源与关联

- `SubagentStart` / `SubagentStop` Hook 发布有界元数据，定位子 transcript；不读取消息正文，不启动额外重试进程。开始通知允许早于文件创建。
- 子文件来自原生 `agent_transcript_path`，或标准 `<session>/subagents/agent-<agent_id>.jsonl` 布局。父文件和子文件使用独立来源键、偏移和缓存。
- collector 从父 transcript 的 `Agent` / `Task` tool use 建立委派。子输入的 `isDelegatedTask`、`parent_tool_use_id` 和可用的 `parent_agent_id` 提供匹配证据；不按名称、文本相似度或时间邻近匹配。
- invocation 为父 session、父 Agent、父 turn 和 tool call ID 的确定性摘要；同一来源重放不改变 ID，新任务使用新 ID。关联状态只保存标识与上下文，不复制任务正文。
- 原生 `sessionId` 相同不代表 turn 相同。父子独立收口；父先完成或 collector 重启不结束仍运行的子 turn。

已确认的结构为 `父 AGENT → 委派 TOOL → 子 AGENT → STEP → LLM/TOOL`。子虚拟 ENTRY 对转换透明；父工具使用预留的实际 Span ID，耗时到原生工具返回为止。子工作只汇总自己的模型用量。

启用上游关联时，在确认首次原生委派或发布完整 turn 时，通过与 InputManager 共用的 TraceLinker 确认上下文。读取首条 prompt 不会提前固定上下文；发布前探测不缓存 miss，允许关联文件晚到。确认委派后，其上下文以 `agent.qoder.trace_context_locked=true` 固定并随 checkpoint 恢复，后来的文件关联不再将已发出的父子工作拆到其他 Trace。子工作继承该上下文，不消耗主 session 的额外关联记录。

早发 invoke 与完整 turn 共用 requestSetId / 字节水位选择 Hook 上下文。同一原生 session 中排队的后续业务调用，不得覆盖先前委派的身份或自定义属性。Span ID 对重复/缺失的 step key 使用确定性出现序号，兼容同一步多次 LLM 与 response-only fallback；真实委派工具的预留 ID 保持不变。

## 日志语义

| 事实 | 输出 |
| --- | --- |
| 原生委派已发生，主 turn 仍在运行 | `gen_ai.agent.invoke`；不等待子结果或主 turn 结束 |
| Agent 工具返回“已启动” | 保留 `tool.result`，不生成成功的 Agent result |
| 同步 `agent-result` 明确交付结果，或明确派发失败 | `gen_ai.agent.result`，沿用原 invocation |
| 后台结果通过原生 task notification 交付 | result 归属实际接收它的父 turn，仍关联原 invocation |
| 旧子 Agent 被再次委派 | 保留 Agent/session 身份，新 turn 和新 invocation |
| 用户直接在旧子执行中输入独立任务 | 不继承此前的 incoming invocation |

后台通知必须同时具有原生 `isMeta` 和 `origin.kind=task-notification` 标识；普通用户文本中的 XML 标签不构成结果证据。通知会唤起独立的父模型轮次，不新建委派。重复通知不重复输出同一结果。

invoke 的任务使用标准 `gen_ai.input.messages`，result 的交付内容使用 `gen_ai.output.messages`。原始工具参数/结果继续保留在工具事件，统一经过工作区过滤和脱敏。当前版本始终采集消息内容，旧 `captureMessageContent=false` 不提供关闭内容的能力。

模型边界优先读取本次响应的原生 usage；流式多条记录的 usage 不累加。缺少 usage 时沿用已有的精确 ID 补全路径。日志新增审计事件不会额外制造模型、工具、STEP 或 Token。

## 恢复与容量

使用现有 `qoderTranscripts` checkpoint 保存来源偏移、当前工作上下文和委派索引。重启后继续读取未结束 turn，已提交事件不重放；半行、临时读取失败和晚到子文件保留原状态。来源出现顺序不影响可靠关联。

未找到父工具时，按直接父 Agent 来源安排优先扫描，并在每轮最多 8 个优先来源、队列最多 128 项的预算内重试；历史目录的普通轮转继续推进。嵌套 Hook 的 `transcript_path` 可能仍是根会话路径，不代表直接父执行。优先使用原生 `parent_agent_id` 定位 sidechain；字段缺失时，只将同一原生 session 内、实际含对应 tool-call ID 的来源作为定位提示，真实关联仍由委派索引确认。

父来源自身等待上一级时，不算已完成直接父扫描。未定位直接父级的 60 秒降级，还需完成一次开始时间不早于 pending 的来源轮转及相关定位读取；重启会重新建立这些扫描证明。定位每轮至多读取一个来源，64 KiB 扫描配额计入现有共享字节预算，跨块行重建沿用 tailer 的软预算；游标最多 128 项、调用提示最多 4096 个 ID，每个 ID 至多保留两个不同来源以识别歧义。提示仅保存标识，游标沿用 tailer 的偏移和有界校验片段，不复制整段消息或任务正文。定位可以增量继续，不每轮重读未变化的待关联正文；达到定位容量会输出诊断。

到期仍无法确认父级时保留独立子执行，诊断 `subagent-parent-unavailable-independent` 携带本 collector 实例的累计 `fallbackCount`，不猜父级，也不在导出后重发 Span 伪装成补挂。委派索引最多保留 4096 项、最长 7 天；容量不足时先回收子执行已结束且结果已交付的关系，全部仍未完成时报告 `subagent-link-capacity`。扫描、单 turn 和正文缓存继续使用原 tailer 的容量限制。

输入与各输出保留现有的接收、重试与 checkpoint 契约。此改动不承诺跨输出端到端恰好一次，也不自动修复历史数据。

## 验证入口与范围

```bash
npm run typecheck
npm test -- tests/integration/qoder-subagent-lifecycle.test.ts tests/unit/inputs/qoder-subagent-boundaries.test.mjs tests/unit/flushers/qoder-turn-converter.test.ts
npm run build
```

CLI 形态的合成输入覆盖 Qoder Input 的并行、复用、嵌套、后台通知、重启、上游上下文、脱敏、缺失父级和最终 Span 挂载。原生协议依据 Qoder CLI 1.1.81；实际 CLI/SDK 安装态、CMS 回读、版本与测试窗口由对应候选验收报告绑定。GUI、Windows 与其他版本的真实交互不能由这些合成测试替代，尤其不能将这些用例当作 IDE 独立子会话适配的证明。

来源：[Qoder Hook](https://docs.qoder.com/cli/hooks)、[Qoder SDK 类型](https://docs.qoder.com/cli/sdk/references-typescript)、[统一子 Agent 模型](subagent-data-model.md)。
