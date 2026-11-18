# Web、Agent SDK、ACP 上游 Trace 透传方案与 POC

目标是把一次 Web 请求与 Pilot 采集到的 Agent 链路串起来：

```text
用户请求 → Web 服务 Span → Pilot ENTRY → Agent / LLM / Tool Span
```

Web 和 Agent 可能在不同进程、不同机器。统一部分是 **W3C carrier 的获取与校验、原生轮次绑定、Pilot 父节点恢复**；每种调用方式只负责把 carrier 送到能识别实际 Agent 轮次的地方。

```text
当前请求的 OTel Context
  → captureIngress(context)
  → CLI 环境变量 / SDK 请求适配 / ACP _meta
  → Agent 入口适配：识别原生 session + turn
  → bindIngress(carrier, session, turn)
  → Pilot linker + OTLP flusher 恢复真实父节点
```

`traceparent` 同时包含 traceId、parent spanId 和采样位；`tracestate` 可选。不要只复制 traceId 或把追踪信息放到 prompt 里。Java/Python 应用用现有探针的当前 Context 和 OTel propagator 生成 carrier；没有有效 Context 时保留独立 Trace。

## 客户接入与我方适配

| 场景 | 客户需要做的事情 | 我方需要提供的能力 |
| --- | --- | --- |
| Web → CLI | 在当前请求中 inject carrier，以独立 env 启动 CLI；启用 Pilot Hook | CLI 首轮已有 env 桥接；给每进程一次调用增加原生 turn 绑定，使恢复 session 也能逐轮关联 |
| Web → Claude SDK | 新进程时可复用兼容 SDK 的自动注入；启用 Pilot Hook | 从可靠的 SDK/Hook 原生 `session_id`、`prompt_id` 绑定；长驻 client 必须按请求维护映射 |
| Web → Codex SDK | 每次请求捕获 Context；每次 exec 的 env 使用该请求的 carrier | Hook 的原生 turn ID 与 transcript 输入记录输出统一 alias；不能把 client 的静态 env 当成逐请求 Context |
| Web → Qoder SDK | 将每次请求 Context 与该 SDK 消息关联 | 适配共享 daemon；确认 SDK 消息 UUID 被真实运行时持久化后，以该 UUID 绑定；补齐锁定 checkpoint 的完整 carrier |
| 微服务 → ACP | 客户端在每次 `session/prompt.params._meta` 传 carrier | ACP 接收端提取 `_meta`，映射到真实 Agent session/turn 后绑定；跨机在 Agent 侧保存关联 |

如果 SDK 或 Agent 不能暴露可靠的逐请求身份，就不能单靠 Pilot 猜出两个并发请求的正确归属。应增加官方 Hook/adapter 协作；无法确定时按独立 Trace 降级，不按最近一次请求或相同文本猜测。

### 恢复会话和长驻进程

环境变量属于进程，不属于请求。一个进程只处理一次外部调用时，可以在该进程的 `UserPromptSubmit` Hook 取出 env + 原生 turn ID，按轮次绑定，即使它恢复了旧 session。一个长驻进程处理多次请求时，不能反复用启动时 env 作为每轮 parent；需要 SDK 消息或 ACP 请求本身携带请求级关联。

对 Qoder，SDK 公开类型允许为用户消息提供 `uuid`。POC 验证了 **SDK 向 daemon 发送了这个 UUID**，但使用了 fixture daemon；仍需用目标 Qoder CLI 版本确认 UUID 与 transcript 用户行一致，并覆盖取消、重试、队列、自动续轮和 checkpoint 恢复。Qoder 原始部署 ID 与归一化 `qoder-cli` 等类型也需统一命名，避免关联文件键不一致。

### ACP 到原生 turn 的时序

ACP `_meta` 只负责把 carrier 送到 Agent 端，不等于 Pilot 已收到。接收端需要在原生轮次身份确定后绑定。部分 adapter 在开始执行后才拿到 turn ID，Pilot 可能已经读到输入。因此生产实现需要对该轮首批事件做**有界暂存**：

1. 只在采集侧等待身份/绑定，不阻塞 Agent 业务调用。
2. 绑定及时到达时，用它创建 ENTRY；超时或失败时整轮使用独立 Trace。
3. 一旦事件或 Span 已发布，该轮 parent 不再改变；重启重放沿用已确认结果。
4. 暂存容量、时间、清理、取消和失败可观测性必须有上限与测试。

POC 的延迟绑定测试只验证绑定发生在发布前时可以成功，不代表完整暂存队列已经实现。

## 可运行 POC

代码位于 [examples/upstream-ingress-poc](../../examples/upstream-ingress-poc/README.md)。这些样例复用同一个实验性 `captureIngress` / `bindIngress`，最终进入 PR #615 的真实 `TraceLinker` 和 `OtlpTraceFlusher`：

1. **Web → CLI**：真实本地 HTTP 请求和子进程，重复 session、重复 prompt、并发请求各自对应正确上游。
   另外用官方 Python OTel API 构造当前 Context，通过 Python propagator 和子进程 env 验证同一条路径；父 SpanContext 是合成的，不能等同真实 Python 探针验收。
2. **Codex SDK**：真实公开 SDK 调用、fixture CLI；两次 resume 同一 session，分别使用各自父节点。
3. **Claude Agent SDK**：真实公开 SDK 注册 UserPromptSubmit 回调，fixture CLI 提供 session 和 prompt ID；两次恢复同一 session，分别绑定对应请求，再由真实 Pilot Claude Hook processor 生成事件。缺少 prompt ID 时不按轮次绑定。
4. **Qoder SDK**：真实公开 SDK 和一个共享 daemon 连接、fixture daemon；同 session 的两条消息 UUID 不同，实际 Pilot Qoder transcript collector 生成事件后，由 POC 薄适配补原生 alias。
5. **ACP**：真实 ACP TypeScript SDK 客户端和服务端，通过 stdio 传 `_meta`；fixture Agent 在生成原生 turn 时调用同一个绑定能力。

附加检查覆盖错误 carrier、缺失身份、重复绑定、冲突 parent、清除旧 env、发布前绑定以及 unsampled parent。每个成功链路同时检查 traceId、ENTRY 的真实 parent、`tracestate` 与最终 Span。fixture Agent、合成 transcript 和 POC 手工补 alias 不等于真实 Agent 的安装态端到端验收；Claude 样例也未验证真实 CLI 是否在目标版本中同时提供一致的 prompt ID。

## 生产落地顺序

1. 收敛统一公开入口：按请求捕获/注入 carrier、绑定原生身份、明确命名和冲突语义；Java/Python 通过进程 env 或有界 stdin/本地 API 调用。
2. 完成 Codex/Claude 入口 Hook 与 transcript alias，验证新建与恢复 session、并发和跨进程一致性。
3. 完成 Qoder SDK/collector 的 UUID 真实性验证、身份映射与 checkpoint carrier；覆盖共享 daemon 与取消/重启。
4. 在实际 Claude/Codex ACP adapter 或 gateway 增加 `_meta` 接收与原生身份桥接，并实现采集侧有界暂存。
5. 以真实 CLI/SDK/ACP、同 prompt 并发、多轮恢复、失败/采样/隐私和 CMS 链路回读验收，再交付生产能力。

此方案只处理 **上游 → Agent/Pilot**。Agent 再调用 HTTP/MCP 工具时的出站上下文传播，需要单独接入实际发送边界。

## 参考

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Python propagation](https://opentelemetry.io/docs/languages/python/propagation/)
- [Claude Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability)
- [Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript)
- [Qoder Agent SDK](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)
- [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility)
