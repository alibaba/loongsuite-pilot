# Pilot 统一双向 W3C 上下文透传

Pilot 在执行后将事件转换成 OTel Span。要让下游成为这些 Span 的子节点，不能等到转换时才生成 ID：公共运行时在请求发送前绑定原生轮次、预留 ENTRY/AGENT/LLM/TOOL ID，采集转换时复用同一组 ID。

```text
Java/Python/其他调用方 Span → Pilot ENTRY → AGENT → STEP → LLM/TOOL → 网关/子进程 Span
```

公共核心使用官方 `W3CTraceContextPropagator`，不另造协议，不注册全局 SDK。传递 Trace ID、采样 flags 和合法 tracestate；上游未采样不会被改为采样。Baggage 不默认传播，避免泄露业务信息。

## 开启

合并到现有配置，重启 collector 和 Claude Code：

```json
{
  "upstreamLink": {
    "enabled": true,
    "sharedContext": true,
    "propagateToTools": true,
    "propagateToLlm": true,
    "generateTraceWhenMissing": true,
    "ttlMs": 86400000
  }
}
```

`sharedContext` 默认关闭，环境覆盖为 `LOONGSUITE_PILOT_UPSTREAM_LINK_SHARED_CONTEXT`。独立开关 `generateTraceWhenMissing` 控制无上游时生成本地根；非法上游不被静默替换。旧行为保持不变。环境覆盖必须同时到达 Agent 与 collector，重启 collector 不会刷新已运行的 Agent preload。

## 上游与框架适配

构建/安装后，通过 `require('loongsuite-pilot/trace-context.cjs')` 加载独立运行时。

1. **请求 Agent 前**：调用 `TraceContextRuntime.bindTurn({agentType, sessionId, turnId, inputHash}, carrier)`，其中 carrier 来自上游当前 OTel Context 的 `injectCarrier(activeContext())`，或 Java/Python 注入得到的 `traceparent/tracestate`。必须使用采集侧的原生会话/轮次 ID，调用方与 collector 共享 dataDir。
2. **Agent 发请求前**：调用 `reserveOperation(binding, 'llm'|'tool', operationId, attemptId)`，用 `bindingContext(binding, operation.spanId)` 得到上下文。物理重试使用不同 attemptId。
3. **按传输选 carrier**：HTTP 用 `injectHttpHeaders`；MCP/ACP JSON-RPC 用 `injectMetadata` 写 `params._meta`；子进程用 `injectEnvironment` 写单次 spawn 的环境，不能改进程全局 `process.env`。下游须主动提取并配置自己的 exporter。
4. **事件转换复用**：每条轮次事件附加 `bindingFields(binding)`，操作请求/响应事件附加同一预留 `span_id`，在真正结束后 `completeTurn(binding)`。原生关联字段在身份覆盖和脱敏之前解析。

HTTP 与 metadata 已有调用方 traceparent 时不覆盖，也不能据此宣称已创建新的 Pilot 父操作。子进程环境则替换继承的旧父上下文。`withTraceContext` 提供单次异步调用作用域，不污染并发请求。

## Claude Code 已接入范围

- `UserPromptSubmit` 在执行前绑定；优先使用 prompt_id，缺失时用提示词 hash 唯一匹配。
- `PreToolUse(Bash)` 注入 TOOL 上下文，Stop 时复用同一 TOOL ID。
- Fetch preload 每次物理发送前读取当前绑定，支持 global fetch / Bun FetchSession，注入本次 LLM ID，失败重试与最终成功各自复用。
- `Stop`/`StopFailure` 输出绑定信息；不同 binding 的请求/响应补全不会跨轮合并。
- 新启动进程的 TRACEPARENT 只用于首轮，后续不复用固定环境；有多个活动轮次却缺少准确请求 ID 时不选“最新一条”。

旧的 [acp-correlate 文件](upstream-trace-correlation.md) 仍支持事后入站关联，但不能单独保证出站前透传。需要双向透传时，调用方应先写共享绑定。缺少原生 turn ID 时，同文本并发无法可靠区分，须增加原生判别字段，不能把唯一 hash 兜底当成多租户并发协议。

本次不安装 OpenClaw、Hermes、MCP、PowerShell 或子 Agent 出站适配器；公共 API 可供它们接入，不代表已经拦截这些框架的真实流量。纯 transcript 采集无法给已经发生的请求添加 Header。

## 状态与限制

状态在 `<dataDir>/trace-context/turns/`，Agent/session 以 hash 分区，仅保存 ID/hash，不保存提示词正文。原子发布、冲突拒绝、重启复用与发布后的关联冻结防止改树。读取单记录最多 16 KiB，单 session 最多扫描 1024 项/保留 128 个未过期绑定，全局最多新建 1024 个 session 目录；容量或权限不足时 fail-open。

默认 TTL 24 小时，最高七天；无效/孤立记录最长七天清理。collector 维护每轮轮转访问 32 个目录。保留期外恢复、跨机器无共享存储、缺少可靠原生身份的并发须另外定义协议，不承诺端到端 exactly-once。

公共核心、真实 HTTP 重试、Bash 子进程及 Hook→事件→转换链路均有回归；MCP 用例仅证明 metadata 序列化与接收端提取，不代表已安装 SDK transport。真实模型、原生 CLI、接收端和 CMS 验收分别记录。

完整 JavaScript 接口和官方参考见 [英文使用指南](../trace-context-propagation.md)。
