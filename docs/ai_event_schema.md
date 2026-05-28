# AI Agent Event Schema

设计原则：

- 采用 OTel 风格的顶层字段和 dotted namespace：`time_unix_nano`、`trace_id`、`span_id`、`event.*`、`host.*`、`error.*`。
- GenAI 领域字段与 OTel Semantic Conventions for Generative AI 保持一致，并在 `gen_ai.*` namespace 下承载会话、轮次、步骤和 Agent 实例等扩展属性：`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.*`、`gen_ai.usage.*`、`gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.tool.*`、`gen_ai.skill.*`、`gen_ai.session.id`、`gen_ai.turn.id`、`gen_ai.step.id`、`gen_ai.agent.*`。
- OTel 规范中尚未覆盖、但需要稳定查询的 Agent 专属字段优先沉淀为结构化列，并遵循“领域前缀 + 语义分组”的命名方式，例如 `gen_ai.agent.*`、`gen_ai.turn.id`、`gen_ai.step.id`、`git.*`、`workspace.*`；临时扩展属性统一放入 `agent.xxx`。
- 一条记录表示一个 Agent 行为事件，使用 `event.name` 区分语义。
- 保留 `session → turn → step → response/tool_call` 层级，方便还原完整执行链路。
- 消息内容、工具参数、工具结果等高变化字段使用 JSON；稳定查询维度沉淀为结构化列。

### 1. event.name 枚举


| `event.name`   | 说明                                                             |
| -------------- | -------------------------------------------------------------- |
| `llm.request`  | 一次 LLM 请求，包含用户输入、上下文增量和请求模型                                    |
| `llm.response` | 一次 LLM 响应，包含文本、reasoning、tool call 意图、finish reason、token/cost |
| `tool.call`    | Agent 发起实际工具调用，非tool call意图                                    |
| `tool.result`  | 工具执行结果                                                         |
| `skill.use`    | 技能或扩展能力调用                                                      |
| `tool.approve` | 用户批准执行                                                         |
| `other`        | 其它未归类事件                                                        |


### 2. ID 层级


| 层级        | 字段                         | 说明                                                            |
| --------- | -------------------------- | ------------------------------------------------------------- |
| Trace     | `trace_id`                 | OTel Trace ID，用于跨系统关联                                         |
| Span      | `span_id`、`parent_span_id` | OTel Span ID 和父 Span ID                                       |
| Event     | `event.id`                 | 单条采集事件的全局唯一 ID，由采集端生成                                         |
| Session   | `gen_ai.session.id`        | 用户会话 / 对话 ID，行为分析和审计的最小关联键（不使用 OTel `gen_ai.conversation.id`） |
| Turn      | `gen_ai.turn.id`           | 一次用户输入到 Agent 最终回复                                            |
| Step      | `gen_ai.step.id`           | 一次 ReAct 循环，通常包含 think/action/observe                         |
| Response  | `gen_ai.response.id`       | 一次 LLM 响应 ID（对齐 OTel `gen_ai.response.id`）                    |
| Tool Call | `gen_ai.tool.call.id`      | 一次工具调用 ID（对齐 OTel `gen_ai.tool.call.id`）                      |


### 3. 全部字段定义

> **必填程度说明**（与 OTel 对齐）：

- `Required` — 必须提供
- `Conditionally Required` — 条件必填，满足括号中条件时必须提供
- `Recommended` — 推荐提供
- `Opt-In` — 可选，按需开启（通常含敏感信息）


| 字段名                                        | 类型           | 必填程度                                       | 成熟度         | 描述与取值规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 示例值                                                                                                |
| ------------------------------------------ | ------------ | ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `time_unix_nano`                           | uint64       | `Required`                                 | stable      | 事件发生时间，Unix 纳秒时间戳。必须使用事件实际发生时刻，不得使用采集时刻代替。如原始字段为毫秒，需乘以 1,000,000 转换。                                                                                                                                                                                                                                                                                                                                                                                                       | `1746614400000000000`                                                                              |
| `observed_time_unix_nano`                  | uint64       | `Recommended`                              | stable      | 采集器观测到该事件的时间，Unix 纳秒。当采集存在延迟时，此字段与 `time_unix_nano` 可能不同。由采集端写入，不由业务代码填充。                                                                                                                                                                                                                                                                                                                                                                                                  | `1746614400123456789`                                                                              |
| `event.id`                                 | string       | `Required`                                 | stable      | 单条采集事件的全局唯一 ID，建议使用 UUID v4 或 ULID。由采集端生成，业务代码不感知。                                                                                                                                                                                                                                                                                                                                                                                                                         | `"01HZ8E2Q3V7W5X6Y9A0B1C2D3E"`                                                                     |
| `event.name`                               | string       | `Required`                                 | stable      | 事件类型，枚举见第 1 节，取值仅限枚举值。                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `"llm.request"`、`"tool.call"`                                                                      |
| `user.id`                                  | string       | `Required`                                 | stable      | 发起请求的用户标识，企业场景下一般为员工号，个人设备场景下为机器名或本地账号名。                                                                                                                                                                                                                                                                                                                                                                                                                                   | `"emp_102938"`、`"macbook-tom"`                                                                     |
| `trace_id`                                 | string       | `Recommended`                              | stable      | OTel W3C Trace ID，32 位小写十六进制字符串，用于跨服务、跨系统关联完整请求链路。无分布式 Tracing 时可留空。                                                                                                                                                                                                                                                                                                                                                                                                       | `"4bf92f3577b34da6a3ce929d0e0e4736"`                                                               |
| `span_id`                                  | string       | `Recommended`                              | stable      | OTel Span ID，16 位小写十六进制字符串，标识当前操作的 Span。                                                                                                                                                                                                                                                                                                                                                                                                                                   | `"00f067aa0ba902b7"`                                                                               |
| `parent_span_id`                           | string       | `Recommended`                              | stable      | 父 Span ID，16 位小写十六进制，用于构建调用树。根 Span 无此字段。                                                                                                                                                                                                                                                                                                                                                                                                                                  | `"3ee2b4b6b9c2f4a1"`                                                                               |
| `host.name`                                | string       | `Recommended`                              | stable      | 运行该 Agent 进程的主机名或 Kubernetes Pod 名。优先取 Pod 名，无则取 `hostname`。                                                                                                                                                                                                                                                                                                                                                                                                               | `"agent-pod-xk29f"`、`"LAPTOP-A1B2C3"`                                                              |
| `host.ip`                                  | string       | `Recommended`                              | stable      | 主机 IP 地址或日志源 IP，点分十进制 IPv4 或 IPv6 字符串。                                                                                                                                                                                                                                                                                                                                                                                                                                     | `"10.0.1.42"`、`"192.168.0.100"`                                                                    |
| `service.name`                             | string       | `Recommended`                              | stable      | Agent 服务名称，用于区分多个 Agent 实例或产品线，通常为部署时的服务标识。                                                                                                                                                                                                                                                                                                                                                                                                                                | `"agent-app-prod"`                                                                                 |
| `gen_ai.session.id`                        | string       | `Conditionally Required` 当 Agent 维护会话上下文时  | development | 用户会话（对话）的唯一标识，用于将同一会话内的多条事件关联为完整交互链路。会话由业务系统分配，跨 Turn 保持不变。                                                                                                                                                                                                                                                                                                                                                                                                                | `96f19667-c280-4582-9ad2-01c5ceae3c21`                                                             |
| `gen_ai.turn.id`                           | string       | `Recommended`                              | development | 一轮用户输入到 Agent 最终回复的唯一标识。一个 Session 内可包含多个 Turn；Turn 开始时由业务端生成。                                                                                                                                                                                                                                                                                                                                                                                                             | `"turn_01HWXQZ9K3P5R7S2T4U6V8W0"`                                                                  |
| `gen_ai.step.id`                           | string       | `Recommended`                              | development | 一次 ReAct 循环（think → action → observe）的唯一标识。一个 Turn 内可包含多个 Step，Step 序号建议从 1 开始递增。                                                                                                                                                                                                                                                                                                                                                                                          | `"step_3"`                                                                                         |
| `gen_ai.response.id`                       | string       | `Recommended`                              | development | LLM 响应的唯一标识，由模型服务返回（如 OpenAI `id` 字段）。同一请求重试时响应 ID 不同。对齐 OTel `gen_ai.response.id`。                                                                                                                                                                                                                                                                                                                                                                                        | `"chatcmpl-A1B2C3D4E5F6"`、`"msg_01XeEkBz..."`                                                      |
| `gen_ai.agent.type`                        | string       | `Required`                                 | development | Agent 产品类型标识，用于区分不同 Agent 产品。取部署时约定的枚举值，不含版本号。                                                                                                                                                                                                                                                                                                                                                                                                                             | `"qoder"`、`"cursor"`、`"cowork"`                                                                    |
| `gen_ai.agent.id`                          | string       | `Recommended`                              | development | Agent 实例的唯一 ID，用于区分同类产品的不同运行实例，通常在进程启动时生成。                                                                                                                                                                                                                                                                                                                                                                                                                                 | `"agent_7fGhJ2kLmN9pQrSt"`                                                                         |
| `gen_ai.agent.name`                        | string       | `Recommended`                              | development | Agent 实例的可读名称，可与 `agent.type` 相同，也可由用户自定义。                                                                                                                                                                                                                                                                                                                                                                                                                                 | `"我的编程助手"`、`"Sales Agent"`                                                                         |
| `gen_ai.provider.name`                     | string       | `Conditionally Required` 如果可获取             | development | 模型服务提供商标识，取 OTel 预定义枚举值（见下方）；自建模型或未列出的提供商使用小写 dotted 格式自定义。对齐 OTel `gen_ai.provider.name`。                                                                                                                                                                                                                                                                                                                                                                                 | `"anthropic"`、`"openai"`、`"aws.bedrock"`、`"gcp.vertex_ai"`                                         |
| `gen_ai.request.id`                        | string       | `Recommended`                              | development | 客户端请求 ID，由客户端或网关生成，用于与提供商侧日志关联。与 `gen_ai.response.id`（服务端分配）区分。                                                                                                                                                                                                                                                                                                                                                                                                            | `"req_4tH7jK2mN5pQ8rS1"`                                                                           |
| `gen_ai.request.model`                     | string       | `Conditionally Required` 如果可获取             | development | 请求时指定的模型名称，应为提供商文档中的精确名称或 fine-tuned 模型名。对齐 OTel `gen_ai.request.model`。                                                                                                                                                                                                                                                                                                                                                                                                   | `"claude-sonnet-4-5"`、`"gpt-4o"`、`"qwen-max"`                                                      |
| `gen_ai.response.model`                    | string       | `Recommended`                              | development | 响应中实际使用的模型名称，可能与请求模型不同（如路由到了其他版本）。对齐 OTel `gen_ai.response.model`。                                                                                                                                                                                                                                                                                                                                                                                                         | `"claude-sonnet-4-5-20251022"`、`"gpt-4o-2024-08-06"`                                               |
| `gen_ai.response.finish_reasons`           | string array | `Recommended`                              | development | 模型停止生成的原因数组。常见枚举值：`stop`（正常结束）、`length`（达到最大 token）、`tool_calls`（触发工具调用）、`content_filter`（内容过滤）。对齐 OTel `gen_ai.response.finish_reasons[0]`。                                                                                                                                                                                                                                                                                                                               | `["stop"]`、`["tool_calls"]`、`["stop", "length"]`                                                   |
| `gen_ai.usage.input_tokens`                | int          | `Recommended`                              | development | 本次请求消耗的输入 token 数，应包含所有类型（含 cached token）。由提供商返回值直接填入；无法获取时可由各类 token 数加总。对齐 OTel `gen_ai.usage.input_tokens`。                                                                                                                                                                                                                                                                                                                                                             | `1024`、`4096`                                                                                      |
| `gen_ai.usage.output_tokens`               | int          | `Recommended`                              | development | 本次响应生成的输出 token 数。对齐 OTel `gen_ai.usage.output_tokens`。                                                                                                                                                                                                                                                                                                                                                                                                                    | `256`、`512`                                                                                        |
| `gen_ai.usage.cache_read.input_tokens`     | int          | `Recommended`                              | development | 从提供商缓存中读取的输入 token 数。该值已包含在 `gen_ai.usage.input_tokens` 中。对齐 OTel `gen_ai.usage.cache_read.input_tokens`。                                                                                                                                                                                                                                                                                                                                                                  | `800`、`2048`                                                                                       |
| `gen_ai.usage.cache_creation.input_tokens` | int          | `Recommended`                              | development | 本次请求写入提供商缓存的输入 token 数。该值已包含在 `gen_ai.usage.input_tokens` 中。对齐 OTel `gen_ai.usage.cache_creation.input_tokens`。                                                                                                                                                                                                                                                                                                                                                            | `1024`、`4096`                                                                                      |
| `gen_ai.usage.total_tokens`                | int          | `Recommended`                              | development | 本次交互总 token 数，等于 `input_tokens + output_tokens`；提供商直接返回时使用返回值，否则在采集端计算。（OTel 规范暂无此字段，作为扩展保留）                                                                                                                                                                                                                                                                                                                                                                               | `1280`、`4608`                                                                                      |
| `gen_ai.usage.input_cost`                  | double       | `Recommended`                              | development | 输入 token 产生的费用，单位为美元（USD）。按提供商当前计费单价 × `gen_ai.usage.input_tokens` 计算（缓存读取按折扣价）。`gen_ai.usage.cache_read.input_cost` 与 `gen_ai.usage.cache_creation.input_cost` 为该字段的分项明细。                                                                                                                                                                                                                                                                                                       | `0.001536`、`0.005`                                                                                 |
| `gen_ai.usage.output_cost`                 | double       | `Recommended`                              | development | 输出 token 产生的费用，单位 USD。                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `0.00384`、`0.015`                                                                                  |
| `gen_ai.usage.cache_read.input_cost`       | double       | `Recommended`                              | development | 缓存读取 token 产生的费用，单位 USD。通常低于普通输入单价。该字段仅用于成本拆分展示，不参与 `gen_ai.usage.total_cost` 计算。                                                                                                                                                                                                                                                                                                                                                                                              | `0.0000768`                                                                                        |
| `gen_ai.usage.cache_creation.input_cost`   | double       | `Recommended`                              | development | 缓存写入 token 产生的费用，单位 USD。该字段仅用于成本拆分展示，不参与 `gen_ai.usage.total_cost` 计算。                                                                                                                                                                                                                                                                                                                                                                                                        | `0.0000192`                                                                                        |
| `gen_ai.usage.total_cost`                  | double       | `Recommended`                              | development | 本次事件总费用，单位 USD，固定等于 `gen_ai.usage.input_cost + gen_ai.usage.output_cost`。                                                                                                                                                                                                                                                                                                                                                                                                  | `0.005376`                                                                                         |
| `gen_ai.input.messages`                    | json array   | `Opt-In`                                   | development | 发送给模型的完整聊天历史，按发送顺序排列。结构遵循 OTel `gen_ai.input.messages` JSON Schema（每条消息含 `role` 和 `parts` 数组）。**含 PII/用户敏感内容，按需开启。** 对齐 OTel `gen_ai.input.messages`。格式：[https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/armsdocs/trace/gen-aimessagesschema/gen-ai-input-messages.json](https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/arms_docs/trace/gen-ai_messages_schema/gen-ai-input-messages.json)                                              | `[{"role":"user","parts":[{"type":"text","content":"帮我写一个快排"}]}]`                                  |
| `gen_ai.input.messages_delta`              | json array   | `Recommended`                              | development | 与上一条 `llm.request` 事件相比，本次新增的输入消息片段（增量）。用于在不重复记录完整上下文的情况下追踪新增输入。结构同 `gen_ai.input.messages`。（OTel 规范扩展字段）                                                                                                                                                                                                                                                                                                                                                                  | `[{"role":"user","parts":[{"type":"text","content":"再优化一下时间复杂度"}]}]`                               |
| `gen_ai.input.messages_hash`               | string       | `Recommended`                              | development | 当前完整输入上下文的哈希值（建议 SHA-256 前 16 字节 hex），用于去重和缓存命中判断，不含敏感内容。（OTel 规范扩展字段）                                                                                                                                                                                                                                                                                                                                                                                                     | `"a3f2d1e8b7c6a5f4"`                                                                               |
| `gen_ai.output.messages`                   | json array   | `Opt-In`                              | development | 模型返回的输出消息数组，每条对应一个 choice/candidate，含 `role`、`parts`（text/tool_call/reasoning）和 `finish_reason`。结构遵循 OTel `gen_ai.output.messages` JSON Schema。含 PII/敏感内容，按需开启。 对齐 OTel `gen_ai.output.messages`。[https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/armsdocs/trace/gen-aimessagesschema/gen-ai-output-messages.json](https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/arms_docs/trace/gen-ai_messages_schema/gen-ai-output-messages.json) | `[{"role":"assistant","parts":[{"type":"text","content":"以下是快速排序实现..."}],"finish_reason":"stop"}]` |
| `gen_ai.tool.name`                         | string       | `Required` 在 `tool.call`/`tool.result` 事件上 | development | 工具名称，与模型调用时的 function name 或 tool name 一致。对齐 OTel `gen_ai.tool.name`。                                                                                                                                                                                                                                                                                                                                                                                                      | `"get_weather"`、`"bash"`、`"web_search"`                                                            |
| `gen_ai.tool.call.id`                      | string       | `Recommended` 如果可获取                        | development | 工具调用 ID，由模型生成，唯一标识一次 tool call 意图，用于将 `tool.call` 与 `tool.result` 事件关联。对齐 OTel `gen_ai.tool.call.id`。                                                                                                                                                                                                                                                                                                                                                                      | `"call_mszuSIzqtI65i1wAUOE8w5H4"`、`"toolu_01A09q90qw90lq..."`                                      |
| `gen_ai.tool.call.exec.id`                 | string       | `Recommended`                              | development | 工具执行侧生成的唯一 ID，区别于模型侧分配的 `gen_ai.tool.call.id`，用于关联执行系统内部日志。                                                                                                                                                                                                                                                                                                                                                                                                                | `"exec_9f3a2b1c4d5e6f70"`                                                                          |
| `gen_ai.tool.call.arguments`               | json         | `Opt-In`                                   | development | 工具调用参数，结构化 JSON 对象，与工具定义的 parameters schema 对应。**可能含敏感信息，按需开启。** 对齐 OTel `gen_ai.tool.call.arguments`。                                                                                                                                                                                                                                                                                                                                                                     | `{"location": "Beijing", "date": "2025-05-07"}`                                                    |
| `gen_ai.tool.call.result`                  | json         | `Opt-In`                                   | development | 工具执行成功返回的结果，结构化 JSON 对象。执行失败时留空，错误信息记录在 `error.type`/`error.message`。**可能含敏感信息，按需开启。** 对齐 OTel `gen_ai.tool.call.result`。                                                                                                                                                                                                                                                                                                                                                  | `{"temperature": "22°C", "condition": "sunny"}`                                                    |
| `gen_ai.tool.call.duration`                | int          | `Recommended`                              | development | 工具实际执行耗时，单位毫秒，从调用发起到收到结果的 wall time。                                                                                                                                                                                                                                                                                                                                                                                                                                       | `423`、`1203`                                                                                       |
| `gen_ai.skill.name`                        | string       | `Conditionally Required` 在 `skill.use` 事件上 | development | 技能名称，与 `SKILL.md` 中定义的 skill name 一致，或 tool execution 加载的 skill 名称。对齐 OTel `gen_ai.skill.name`。                                                                                                                                                                                                                                                                                                                                                                            | `"code_review"`、`"web_search"`、`"pptx"`                                                            |
| `gen_ai.system_instructions`               | json array   | `Opt-In`                                   | development | 模型的 system instructions，以 `MessagePart[]` 数组形式记录，每个 part 含 `type` 和 `content`。**仅 Codex 端有值** — 数据源为 codex transcript 的 `session_meta.payload.base_instructions.text`（主 system prompt）+ `turn_context.payload.developer_instructions`（per-turn dev context，取最后一次）。Claude transcript 不含此数据，Claude 端不输出。                                                                                                                                                          | `[{"type":"text","content":"You are a helpful coding agent..."},{"type":"text","content":"Working in repo X, branch main"}]` |
| `gen_ai.tool.definitions`                  | json array   | `Opt-In`                                   | development | 模型可用的工具定义集合，每项为 `FunctionToolDefinition` `{type, name, description, parameters}`。**仅 Codex 端有值** — 数据源为 codex transcript 的 `session_meta.payload.dynamic_tools[]`。注意 codex 的核心工具（`shell` / `apply_patch` / `update_plan` / `web_search`）是嵌入 system prompt 的伪工具，不出现在此字段中，但在 `gen_ai.system_instructions` 中可见。                                                                                                                                                  | `[{"type":"function","name":"web_search","description":"...","parameters":{...}}]`                  |
| `error.type`                               | string       | `Conditionally Required` 操作以错误结束时          | stable      | 错误类型，低基数字符串标识符。应使用提供商返回的错误码、异常类名或 HTTP 状态码。对齐 OTel `error.type`。固定回退值为 `_OTHER`。有错误时error.type必填，没错误时不允许填。                                                                                                                                                                                                                                                                                                                                                                 | `"rate_limit_exceeded"`、`"context_length_exceeded"`、`"timeout"`、`"500"`                            |
| `error.message`                            | string       | `Recommended` 当 `error.type` 存在时           | stable      | 错误详情描述，人类可读的错误信息。不应重复 `error.type` 的内容，应提供附加上下文（如错误堆栈摘要、提供商返回的 message 字段）。                                                                                                                                                                                                                                                                                                                                                                                                | `"Rate limit: 1000 requests/minute exceeded"`                                                      |
| `git.domain`                               | string       | `Recommended`                              | development | 当前工作区关联的 Git 服务域名，用于区分代码托管来源。                                                                                                                                                                                                                                                                                                                                                                                                                                              | `"github.com"`、`"code.alibaba-inc.com"`                                                            |
| `git.repo`                                 | string       | `Recommended`                              | development | 当前工作区关联的 Git 仓库标识，建议使用 `owner/repo` 或平台内等价路径。                                                                                                                                                                                                                                                                                                                                                                                                                              | `"org/project"`                                                                                    |
| `git.branch`                               | string       | `Recommended`                              | development | 当前工作区所在 Git 分支名。                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `"main"`、`"feature/add-agent-metrics"`                                                             |
| `workspace.current_root`                   | string       | `Recommended`                              | development | 当前 Agent 运行或采集事件对应的工作区根目录路径。                                                                                                                                                                                                                                                                                                                                                                                                                                               | `"/Users/tom/project"`、`"/workspace/project"`                                                      |
| `agent.xxx`                                | json         | `Opt-In`                                   |             | 非标准扩展属性 KV 集合，用于承载暂未纳入上述字段的临时属性。稳定、高查询频率的维度应尽快沉淀为结构化列，不应长期停留在此字段。                                                                                                                                                                                                                                                                                                                                                                                                          | `{"openclaw.session.source": "vscode"}`                                                            |


---

### 4. gen_ai.provider.name 枚举值


| 值                    | 说明                          |
| -------------------- | --------------------------- |
| `anthropic`          | Anthropic Claude 系列         |
| `openai`             | OpenAI GPT 系列               |
| `aws.bedrock`        | AWS Bedrock 托管模型            |
| `azure.ai.openai`    | Azure OpenAI Service        |
| `azure.ai.inference` | Azure AI Inference          |
| `gcp.vertex_ai`      | Google Cloud Vertex AI      |
| `gcp.gemini`         | Google Gemini（AI Studio 端点） |
| `gcp.gen_ai`         | Google 通用 GenAI 端点（具体后端未知时） |
| `deepseek`           | DeepSeek                    |
| `qwen`               | 阿里云通义千问（OTel 扩展）            |
| `groq`               | Groq                        |
| `mistral_ai`         | Mistral AI                  |
| `cohere`             | Cohere                      |
| `perplexity`         | Perplexity                  |
| `x_ai`               | xAI Grok                    |
| `ibm.watsonx.ai`     | IBM Watsonx AI              |


如以上枚举均不适用，使用 `{公司}.{产品}` 格式自定义，例如 `baidu.ernie`、`zhipu.chatglm`。

---

### 5. gen_ai.response.finish_reasons 枚举值


| 值                | 说明              |
| ---------------- | --------------- |
| `stop`           | 模型正常生成完毕        |
| `length`         | 达到最大输出 token 限制 |
| `tool_calls`     | 模型触发工具调用，等待工具结果 |
| `content_filter` | 内容安全过滤触发        |
| `end_turn`       | 模型主动结束（部分提供商）   |


---

### 6. 典型事件示例

#### llm.request 事件

```json
{
  "time_unix_nano": 1746614400000000000,
  "event.id": "01HZ8E2Q3V7W5X6Y9A0B1C2D3E",
  "event.name": "llm.request",
  "user.id": "emp_102938",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "service.name": "qoder",
  "gen_ai.agent.type": "qoder",
  "gen_ai.session.id": "sess_7Kp3mXq2nR8tYvWz",
  "gen_ai.turn.id": "turn_01HWXQZ9K3P5R7S2T4U6V8W0",
  "gen_ai.step.id": "step_1",
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-sonnet-4-5",
  "gen_ai.input.messages_delta": [
    {"role": "user", "parts": [{"type": "text", "content": "帮我写一个快速排序"}]}
  ],
  "gen_ai.input.messages_hash": "a3f2d1e8b7c6a5f4"
}

```

#### llm.response 事件

```json
{
  "time_unix_nano": 1746614401500000000,
  "event.id": "01HZ8E2Q3V7W5X6Y9A0B1C2D3F",
  "event.name": "llm.response",
  "user.id": "emp_102938",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b8",
  "parent_span_id": "00f067aa0ba902b7",
  "service.name": "qoder",
  "gen_ai.agent.type": "qoder",
  "gen_ai.session.id": "sess_7Kp3mXq2nR8tYvWz",
  "gen_ai.turn.id": "turn_01HWXQZ9K3P5R7S2T4U6V8W0",
  "gen_ai.step.id": "step_1",
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-sonnet-4-5",
  "gen_ai.response.id": "msg_01XeEkBzNVMBRwXS4CgkV6gZ",
  "gen_ai.response.model": "claude-sonnet-4-5-20251022",
  "gen_ai.response.finish_reasons": ["stop"],
  "gen_ai.usage.input_tokens": 1024,
  "gen_ai.usage.output_tokens": 256,
  "gen_ai.usage.cache_read.input_tokens": 800,
  "gen_ai.usage.cache_creation.input_tokens": 0,
  "gen_ai.usage.total_tokens": 1280,
  "gen_ai.usage.input_cost": 0.001536,
  "gen_ai.usage.output_cost": 0.00384,
  "gen_ai.usage.cache_read.input_cost": 0.0000768,
  "gen_ai.usage.total_cost": 0.005376
}

```

#### tool.call 事件

```json
{
  "time_unix_nano": 1746614402000000000,
  "event.id": "01HZ8E2Q3V7W5X6Y9A0B1C2D3G",
  "event.name": "tool.call",
  "user.id": "emp_102938",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "service.name": "qoder",
  "gen_ai.agent.type": "qoder",
  "gen_ai.session.id": "sess_7Kp3mXq2nR8tYvWz",
  "gen_ai.turn.id": "turn_01HWXQZ9K3P5R7S2T4U6V8W0",
  "gen_ai.step.id": "step_2",
  "gen_ai.tool.name": "bash",
  "gen_ai.tool.call.id": "call_mszuSIzqtI65i1wAUOE8w5H4",
  "gen_ai.tool.call.arguments": {"command": "python3 sort.py"}
}

```

#### tool.result 事件

```json
{
  "time_unix_nano": 1746614402843000000,
  "event.id": "01HZ8E2Q3V7W5X6Y9A0B1C2D3H",
  "event.name": "tool.result",
  "user.id": "emp_102938",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "service.name": "qoder",
  "gen_ai.agent.type": "qoder",
  "gen_ai.session.id": "sess_7Kp3mXq2nR8tYvWz",
  "gen_ai.turn.id": "turn_01HWXQZ9K3P5R7S2T4U6V8W0",
  "gen_ai.step.id": "step_2",
  "gen_ai.tool.name": "bash",
  "gen_ai.tool.call.id": "call_mszuSIzqtI65i1wAUOE8w5H4",
  "gen_ai.tool.call.exec.id": "exec_9f3a2b1c4d5e6f70",
  "gen_ai.tool.call.duration": 843,
  "gen_ai.tool.call.result": {"stdout": "[1, 2, 3, 5, 8]", "exit_code": 0}
}

```

