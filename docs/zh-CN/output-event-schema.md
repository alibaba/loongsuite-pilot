# 输出事件 Schema

[English](../output-event-schema.md) | 简体中文

LoongSuite Pilot 会将采集到的活动归一化为 GenAI 遥测事件。Pilot 当前输出格式是 GenAI audit-event 的一个变体。敏感内容字段是 opt-in 字段，可在输出前进行脱敏。

下面的类型描述的是规范化事件的语义值。JSONL 保留原生 JSON 类型；SLS 等只接受字符串列的后端可在各自输出边界进行序列化。

## Event Names

| `event.name` | 说明 |
|--------------|------|
| `llm.request` | 一次 LLM 请求，包含用户输入、上下文增量和请求模型。消息角色在消息 payload 中表示。 |
| `llm.response` | 一次 LLM 响应，包含文本、reasoning、tool-call 意图、finish reason、token 用量和费用等可用信息。 |
| `tool.call` | Agent 发起的一次实际工具执行。 |
| `tool.result` | 工具执行返回的结果。 |
| `skill.use` | 技能、扩展能力或 Agent 能力调用。 |
| `tool.approve` | 用户批准工具或动作执行的事件。 |
| `other` | 无法归类到上述类型的其他事件。 |

四类核心事件的 `event.name` 与 GenAI audit-event 对应关系如下：

| Pilot `event.name` | GenAI audit-event `event.name` |
|--------------------|--------------------------------|
| `llm.request` | `gen_ai.model.request` |
| `llm.response` | `gen_ai.model.response` |
| `tool.call` | `gen_ai.tool.call` |
| `tool.result` | `gen_ai.tool.result` |

## 字段说明

必填程度与 OpenTelemetry 语义保持一致：

- `Required` - 始终提供。
- `Conditionally Required` - 条件满足时提供。
- `Recommended` - 当源 Agent 暴露该数据时提供。
- `Opt-In` - 可选字段，通常包含敏感信息，仅在需要时开启。

| 字段 | 类型 | 必填程度 | 说明 |
|------|------|----------|------|
| `time_unix_nano` | uint64 | Required | 语义事件发生时间，Unix 纳秒。对于配对 span，它表示真实的 request/response 或 call/result 边界，而不是采集时间。 |
| `observed_time_unix_nano` | uint64 | Recommended | collector 观察到事件的时间，Unix 纳秒；它可以与源事件时间不同。 |
| `event.id` | string | Required | collector 生成的全局唯一事件 ID。 |
| `event.name` | string | Required | 事件名称，见 [Event Names](#event-names)。 |
| `user.id` | string | Required | 用户标识，例如员工号、本地账号或机器级身份。 |
| `trace_id` | string | Recommended | W3C Trace ID，用于跨系统关联完整请求链路。 |
| `span_id` | string | Recommended | 当前 Span ID。 |
| `parent_span_id` | string | Recommended | 父 Span ID。根 Span 为空。 |
| `host.name` | string | Recommended | Agent 所在主机名、Pod 名或机器名。 |
| `host.ip` | string | Recommended | 主机 IP 或日志源 IP。 |
| `service.name` | string | Recommended | 用于区分 Agent 实例或产品线的服务名。 |
| `gen_ai.session.id` | string | 当 Agent 维护会话上下文时 Conditionally Required | 用户会话或对话 ID。 |
| `gen_ai.turn.id` | string | Recommended | 一次用户请求到 Agent 最终响应的轮次 ID。 |
| `gen_ai.step.id` | string | Recommended | 一次 ReAct 循环或 Agent 中间步骤。 |
| `gen_ai.response.id` | string | Recommended | 模型 Provider 返回的 LLM response ID。 |
| `gen_ai.agent.type` | string | Required | Agent 产品类型，例如 `claude-code`、`codex`、`cursor`、`qoder` 或 `qoder-work`。 |
| `gen_ai.agent.id` | string | Recommended | Agent 运行实例 ID。 |
| `gen_ai.agent.name` | string | Recommended | Agent 实例可读名称。 |
| `gen_ai.provider.name` | string | Required | 模型 Provider 名称，见 [Provider Names](#provider-names)。 |
| `gen_ai.request.id` | string | Recommended | 客户端请求 ID，用于关联网关或 Provider 日志。 |
| `gen_ai.request.model` | string | 可获取时 Conditionally Required | 客户端请求的模型。 |
| `gen_ai.response.model` | string | Recommended | 实际用于响应的模型。 |
| `gen_ai.response.finish_reasons` | string[] | Recommended | 生成停止原因，见 [Finish Reasons](#finish-reasons)。 |
| `gen_ai.usage.input_tokens` | int | Recommended | 请求消耗的输入 token。 |
| `gen_ai.usage.output_tokens` | int | Recommended | 响应生成的输出 token。 |
| `gen_ai.usage.cache_read.input_tokens` | int | Recommended | 从 Provider 缓存读取的输入 token，已包含在 `gen_ai.usage.input_tokens` 中。 |
| `gen_ai.usage.cache_creation.input_tokens` | int | Recommended | 写入 Provider 缓存的输入 token，已包含在 `gen_ai.usage.input_tokens` 中。 |
| `gen_ai.usage.total_tokens` | int | Recommended | 本次交互总 token。 |
| `gen_ai.usage.input_cost` | double | Recommended | 有价格信息时的输入 token 成本，单位 USD。 |
| `gen_ai.usage.output_cost` | double | Recommended | 有价格信息时的输出 token 成本，单位 USD。 |
| `gen_ai.usage.cache_read.input_cost` | double | Recommended | 缓存读取 token 成本，单位 USD。 |
| `gen_ai.usage.cache_creation.input_cost` | double | Recommended | 缓存写入 token 成本，单位 USD。 |
| `gen_ai.usage.total_cost` | double | Recommended | 本次事件总成本，单位 USD。 |
| `gen_ai.input.messages` | json array | Opt-In | 发送给模型的完整消息，可能包含敏感内容。 |
| `gen_ai.input.messages_delta` | json array | Recommended | 相比上一条 `llm.request` 新增的输入消息片段。 |
| `gen_ai.input.messages_hash` | string | Recommended | 完整输入上下文 hash，用于去重和缓存分析。 |
| `gen_ai.output.messages` | json array | Opt-In | 模型输出消息，包含文本、reasoning、tool-call parts 和 finish reason，可能包含敏感内容。 |
| `gen_ai.tool.name` | string | `tool.call` 和 `tool.result` Required | 工具名称。 |
| `gen_ai.tool.call.id` | string | 可获取时 Recommended | 用于关联 `tool.call` 和 `tool.result` 的工具调用 ID。 |
| `gen_ai.tool.call.exec.id` | string | Recommended | 工具执行侧 ID。 |
| `gen_ai.tool.call.arguments` | json | Opt-In | 工具调用参数，可能包含敏感内容。 |
| `gen_ai.tool.call.result` | json | Opt-In | 工具结果 payload，可能包含敏感内容。 |
| `gen_ai.tool.call.duration` | int | Recommended | 使用匹配的 result 边界减去 call 边界得到的正数工具执行耗时，单位毫秒；任一边界缺失或差值非正时省略。 |
| `gen_ai.skill.name` | string | `skill.use` Conditionally Required | 技能或扩展能力名称。 |
| `gen_ai.skill.id` | string | 技能标识可用时 Recommended | 稳定的技能标识。 |
| `gen_ai.skill.description` | string | 技能元数据可用时 Recommended | 技能描述。 |
| `gen_ai.skill.version` | string | 技能元数据可用时 Recommended | 技能版本。 |
| `error.type` | string | 操作以错误结束时 Conditionally Required | 低基数错误类型、错误码、异常类名或 HTTP 状态。 |
| `error.message` | string | `error.type` 存在时 Recommended | 人类可读错误详情。 |
| `agent.channel` | string | Recommended | 请求来源渠道，例如 `ide_plugin`、`web` 或 `api`。 |
| `git.domain` | string | Recommended | 当前 workspace 的 Git 托管域名。 |
| `git.repo` | string | Recommended | 当前 workspace 的 Git 仓库名或 URL。 |
| `git.branch` | string | Recommended | 当前 Git 分支。 |
| `workspace.current_root` | string | Recommended | Git 顶层目录，仅当工作目录是 git 仓库时推断得出。 |
| `workspace.path` | string | Recommended | agent 进程实际运行的工作目录（cwd），与 git 无关。即使目录不是 git 仓库也会带上。 |
| `agent.*` | json | Opt-In | Agent-specific 扩展属性。稳定且高频查询的维度应逐步沉淀为结构化字段。 |

## AgentTeams 调用上下文

当支持的 Agent 进程携带以下环境变量启动时，Pilot 会将 Worker 上下文写入当前 Turn：

| 环境变量 | Event 字段 | 说明 |
|----------|------------|------|
| `AGENTTEAMS_WORKER_NAME` | `gen_ai.agent.name`、`resourceAttributes["agentteams.worker.name"]` | 逻辑 Worker 名称；主 Agent 上优先于 Agent 原生名称。 |
| `AGENTTEAMS_INSTANCE_ID` | `resourceAttributes["agentteams.instance.id"]` | 当前 Worker 运行实例；不会覆盖 `gen_ai.agent.id`。 |

当前支持 Claude Code、Qoder、Codex、OpenCode、Pi Coding Agent、MiMo Code、Qwen Code CLI 和 Cursor CLI。Cursor Desktop 不读取这组变量。未设置变量时，现有事件字段和名称回退行为不变。Pilot 只采集上述固定白名单字段；其他 `AGENTTEAMS_*` 变量不会进入事件或 OTLP Resource。

## Provider Names

| 值 | 说明 |
|----|------|
| `anthropic` | Anthropic Claude 模型。 |
| `openai` | OpenAI 模型。 |
| `aws.bedrock` | AWS Bedrock 托管模型。 |
| `azure.ai.openai` | Azure OpenAI Service。 |
| `azure.ai.inference` | Azure AI Inference。 |
| `gcp.vertex_ai` | Google Cloud Vertex AI。 |
| `gcp.gemini` | Google Gemini AI Studio endpoint。 |
| `gcp.gen_ai` | Google GenAI endpoint，具体后端未知时使用。 |
| `deepseek` | DeepSeek。 |
| `qwen` | 阿里云通义千问。 |
| `groq` | Groq。 |
| `mistral_ai` | Mistral AI。 |
| `cohere` | Cohere。 |
| `perplexity` | Perplexity。 |
| `x_ai` | xAI Grok。 |
| `ibm.watsonx.ai` | IBM Watsonx AI。 |

如果以上值都不适用，使用小写 dotted provider 名称，例如 `baidu.ernie` 或 `zhipu.chatglm`。

## Finish Reasons

| 值 | 说明 |
|----|------|
| `stop` | 模型正常生成结束。 |
| `length` | 达到最大输出 token 限制。 |
| `tool_calls` | 模型触发工具调用。 |
| `content_filter` | 内容安全过滤停止生成。 |
| `end_turn` | 模型结束当前轮次。 |
| `cancelled` | 用户中断生成，不表示 Provider 或 Agent 错误。 |
