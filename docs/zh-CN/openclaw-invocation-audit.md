# OpenClaw 工作级委派审计

对应 [#485](https://github.com/alibaba/loongsuite-pilot/issues/485)。沿用现有子会话、父工具 Span 和独立生命周期，新增标准 `gen_ai.agent.invoke/result` 日志；不把委派日志转成额外的执行 Span。

## 数据来源

- `before_tool_call` 中的 `sessions_spawn` / `sessions_send` 表示提交新工作。每个父 session、turn、原生 tool call 生成稳定的 SHA-256 invocation ID；查询和取消工具不产生委派。
- `after_tool_call` 的原生 child runId 绑定已有子上下文。子工作的模型、工具和边界事件携带 `gen_ai.agent.parent.invocation.id`，保留自己的 session/turn。嵌套调用同时保留 incoming 和 outgoing。
- accepted 只表示受理。同步 `sessions_send` 的实际 reply、明确派发失败，或父侧 `before_message_write` 里带有 `provenance.kind=inter_session`、`sourceTool=subagent_announce` 的消息，才记录 result。纯文本中的相似提示不能建立关系。
- 后台结果采用实际接收 turn，反查发起 turn 使用 invoke。交付日志不伪造旧工具仍在执行，不复制工具参数或 token。消息内容走已有归一化、脱敏和输出链路。

上下文复用现有私有目录和原子替换，新增状态仅为工作 ID、原生定位及结果指纹，不额外保存任务正文。输出写入失败不能将结果标为已记录。源重放可能重发相同 event ID；接收方仍需去重，不承诺端到端恰好一次。

## 支持边界

- 同一子 session 的新 `sessions_send` 使用新 invocation；它不会重构此前未关联的 send Trace。
- 某些版本的异步回传只提供 source session key，不提供原生 work/run key。该 session 对应多个历史委派时无法唯一消歧，省略 result，不能选最近任务；同步 reply 仍按真实 call 配对。
- 早到事件超限独立导出后，只补已确认的审计关联，不回写已导出 Trace。进程内暂存仍保留原有崩溃窗口。
- 未经验证的 ACP、跨主机传播及缺少原生 provenance 的版本不在完整支持范围内。

## 验证

单元覆盖早到、嵌套、新工作、查询排除、失败、重启、歧义、结果去重及写入失败重试。集成覆盖 JSONL、真实 localhost HTTP、SLS SDK 边界和脱敏；实际子 AGENT 的 incoming 进入最终 Span，审计事件不创建或关闭 Trace buffer。

2026-10-20 使用官方 OpenClaw 2026.10.5、Node 24.16.0、`qwen-plus`，从候选安装包加载插件，验证真实派发、读取成功/失败、后台回传以及重启后的子会话新工作。为适配本机环境，将隔离 Node 副本命名为 `pilot-runtime`，进程显示名为 `pilot-gateway-check`；产品 ID、插件 ID 和协议保持原值。

最终候选的新派发窗口产生 79 条规范事件（2 条 invoke、2 条 result），26 条子工作事件全部携带匹配 incoming。真实源事件经候选转换器和正式 OTLP exporter 发送到 localhost，解码后核对 40 个 Span 的 ID 集合；移除审计日志再转换时，执行数量、语义时间和逐 LLM token 相同。本轮最新宿主仍产生一条原有的孤立 tool.result，移除审计日志后同样出现，保留警告及严格校验失败，不把专项关系验证称为全量语义验收。生产云端回读和控制台验收未执行。
