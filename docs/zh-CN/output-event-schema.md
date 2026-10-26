# 输出事件 Schema

[English](../output-event-schema.md) | 简体中文

LoongSuite Pilot 会将采集到的活动归一化为 GenAI 遥测事件。Pilot 当前输出格式是 GenAI audit-event 的一个变体。敏感内容字段是 opt-in 字段，可在输出前进行脱敏。

下面的类型描述的是规范化事件的语义值。JSONL 保留原生 JSON 类型；SLS 等只接受字符串列的后端可在各自输出边界进行序列化。

## Hermes / OpenClaw 的源 JSONL 写出时机

Hermes 在 `pre_api_request` 中为本次 API 请求分配固定的 `span_id`，同步追加
`llm.request` 到 `logs/hermes-agent/*.jsonl`；对应响应复用相同 ID。响应、工具调用和
工具结果在各自 hook 可获得数据时追加，回合结束只补齐旧版本缺失的响应内容及结束标记，
不会重复写出已经成功追加的事件。没有响应的请求保留请求记录，不合成成功响应。
新版 lazy-forward streaming helper 与旧版方法签名均支持 TTFT 观测。

增量 Hermes 事件携带 `agent.hermes.collection=realtime-v1`；回合结束记录为
`event.name=other`、`agent.hermes.hook=turn_end`、`gen_ai.turn.end=true`。
collector 以该标记结束 trace 聚合，避免重试中的 error/stop 或同会话并发回合提前截断 trace。
旧版插件事件仍沿用原有结束判定。源 JSONL 追加不等待 collector 生成完整 trace 或上报完成。

OpenClaw modern 插件在 `model_call_started` 中分配本次模型调用的 `span_id`，
响应复用该 ID。尚未关联父上下文的子 Agent 事件仍使用有界缓冲，以维持父子 trace 关系；
有拦截策略的工具事件也需先完成策略判定，不能承诺所有 hook 都在判定前写出。

跨进程读取成功追加的行不要求每条记录 `fsync`。此处的实时性指源插件文件的可见性，
不是规范化 `logs/output` 文件或远端 SLS/ARMS 的实时可见性。
下游传播器应在 Pilot 对应请求 hook **之后**、实际网络发送**之前**，按
`gen_ai.session.id`、`gen_ai.turn.id`，以及 Hermes 的 `gen_ai.request.id`
或 OpenClaw 的 `gen_ai.step.id`（模型 call ID）选择本次请求，
并对一轮内每次 API 请求重新读取。`pre_llm_call` 早于请求分配，缓存一次或读取全局
最后一行可能得到空值、前一次调用或其他会话的 ID，不能由提前写盘单独解决。
工具出站请求应关联对应的 `tool.call`，不可把一轮的 LLM SpanID 用作所有出站请求的 ID。

增量 Hermes 插件和对应 collector 应一起部署；旧 collector 不理解新增的显式回合结束协议。

## Event Names

OpenClaw 2026.3.8 起的 legacy 和 modern 插件均支持原生逻辑路由字段
`agent.openclaw.session_key`。已取得 key 的运行事件（`other`、`agent.input`、
`llm.request`、`llm.response`、`tool.call`、`tool.result`）会保留该字段，
同一轮上下文明确时也会填入 ENTRY、AGENT、STEP、LLM、TOOL Span 属性，
不会放入 Resource。`session_start` / `session_end` 仍不进入规范化输出。

该字段不替代 `gen_ai.session.id`：reset 后 UUID 可以变化而 key 不变。
缺失、非法、超过 1024 字符或冲突时不猜测；混合父子 Agent 上下文也不继承父级 key。
key 可能包含渠道用户/群组标识，输出前遵循配置的脱敏规则；关闭消息内容采集
不会移除这项元数据。JSONL/SLS 仅新增该精确字段的例外，不放开其他内部字段。
不会自动创建 SLS 索引或 ARMS 专用展示列。

| `event.name` | 说明 |
|--------------|------|
| `llm.request` | 一次 LLM 请求，包含用户输入、上下文增量和请求模型。消息角色在消息 payload 中表示。 |
| `llm.response` | 一次 LLM 响应，包含文本、reasoning、tool-call 意图、finish reason、token 用量和费用等可用信息。 |
| `tool.call` | Agent 发起的一次实际工具执行。 |
| `tool.result` | 工具执行返回的结果。 |
| `gen_ai.model.request` / `gen_ai.model.response` | 标准模型事件名；与 `llm.request` / `llm.response` 同等识别，保留输入名称。 |
| `gen_ai.tool.call` / `gen_ai.tool.result` | 标准工具事件名；与 `tool.call` / `tool.result` 同等识别，保留输入名称。 |
| `gen_ai.agent.invoke` | 向另一个 Agent 提交一次逻辑工作；批量工作逐项记录。 |
| `gen_ai.agent.result` | 实际收到的 Agent 结果或派发失败；工具受理回执不等于 Agent 完成。 |
| `skill.use` | 技能、扩展能力或 Agent 能力调用。 |
| `tool.approve` | 用户批准工具或动作执行的事件。 |
| `agent.input` | 输入型 `other` 的兼容副本，便于按事件名查询 Agent 输入。 |
| `other` | 无法归类到上述类型的其他事件。 |

兼容期内，携带 `gen_ai.input.messages` 或 `gen_ai.input.messages_delta` 的
`other` 会被原样保留，并紧邻追加一条 `agent.input`。兼容副本保留输入内容
和上下文字段，使用从原 ID 确定性派生的新 `event.id`，但不复制
`gen_ai.turn.start` 和 `gen_ai.turn.end`；旧 `other` 仍是唯一的 Turn 边界事件。
双写发生在脱敏之后，因此两条事件携带相同的脱敏内容。没有规范输入字段时不生成
`agent.input`。生成副本时，SLS、JSONL 和 HTTP 保留两条事件；OTLP Trace
转换继续消费旧 `other`，并在转换前排除兼容副本，因此不会增加空 STEP。

四类核心事件的 `event.name` 与 GenAI audit-event 对应关系如下：

| Pilot `event.name` | GenAI audit-event `event.name` |
|--------------------|--------------------------------|
| `llm.request` | `gen_ai.model.request` |
| `llm.response` | `gen_ai.model.response` |
| `tool.call` | `gen_ai.tool.call` |
| `tool.result` | `gen_ai.tool.result` |

六个标准名不会归为 `other`。已有四类短名输出不改名，也不因支持标准名而双写。
OTLP 转换在入口适配名称并排除委派审计视角，避免重复 Span、STEP 和 token。

Codex 子线程始终保留自身 session/turn/step；同 Trace 可以包含多个 session。
父 invoke/result 使用 `gen_ai.agent.invocation.id`，实际子工作使用相等的
`gen_ai.agent.parent.invocation.id`。复用子 session 接受新工作时换新 invocation；
嵌套事件同时保留 incoming 与 outgoing。父子会话定位以两侧事件的 invocation
及自身 session/turn 为准；缺侧不猜测。详见[子 Agent 数据模型](subagent-data-model.md)。

## 字段说明

必填程度与 OpenTelemetry 语义保持一致：

- `Required` - 始终提供。
- `Conditionally Required` - 条件满足时提供。
- `Recommended` - 当源 Agent 暴露该数据时提供。
- `可获取时` - 集成提供该字段时即会上报。
- `Opt-In` - 依赖独立开启的功能，例如多模态上传。

| 字段 | 类型 | 必填程度 | 说明 |
|------|------|----------|------|
| `time_unix_nano` | uint64 | Required | 语义事件发生时间，Unix 纳秒。对于配对 span，它表示真实的 request/response 或 call/result 边界，而不是采集时间。 |
| `observed_time_unix_nano` | uint64 | Recommended | collector 观察到事件的时间，Unix 纳秒；它可以与源事件时间不同。 |
| `event.id` | string | Required | collector 生成的全局唯一事件 ID。 |
| `event.name` | string | Required | 事件名称，见 [Event Names](#event-names)。 |
| `user.id` | string | Required | 用户标识，例如员工号、本地账号或机器级身份。 |
| `user.name` | string | 源 Agent 暴露时 Recommended | Agent 账号的短名称或登录名。Qoder / Qoder CN IDE 使用 Stop hook 的 `extra.user.name`；Qoder CLI 使用 `qodercli status` 返回的 `username`。Qoder / Qoder CN 桌面版在明确的 App 调用中优先使用 Hook 身份，否则分别读取 `~/.qoder/.qoder-app-status.json` / `~/.qoder-cn/.qoder-app-status.json` 的已登录账号公开快照；不会使用独立 CLI 的账号。该字段独立于 `user.id`。 |
| `user.email` | string | 源 Agent 暴露时 Recommended | Agent 账号邮箱。Qoder IDE 使用 Stop hook 的 `extra.user.email`；Qoder CN IDE 还支持 `extra.email`；Qoder CLI 使用 `qodercli status` 返回的 `email`。Qoder / Qoder CN 桌面版优先使用 Hook 邮箱，否则使用各自公开账号快照中存在的邮箱。手机号注册等没有邮箱的账号只写用户名，不推导邮箱；退出登录、来源缺失或读取失败时省略无法获取的字段。 |
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
| `gen_ai.agent.parent.id` | string | 有可靠来源时 Recommended | 当前工作的上游 Agent 身份，不替代 invocation。 |
| `gen_ai.agent.peer.id` | string | 有可靠来源时 Recommended | 本次 invoke/result 的直接交互 Agent。 |
| `gen_ai.agent.invocation.id` | string | 委派事件 Required | 当前向外逻辑委派的稳定 ID；批量逐工作唯一。 |
| `gen_ai.agent.parent.invocation.id` | string | 已确认接受委派的工作 Required | 当前事件/轮次所接受的上游委派 ID；不是子 session 的永久属性。 |
| `gen_ai.agent.name` | string | Recommended | Agent 实例可读名称。 |
| `gen_ai.provider.name` | string | Required | 模型 Provider 名称，见 [Provider Names](#provider-names)。 |
| `gen_ai.request.id` | string | Recommended | 客户端请求 ID，用于关联网关或 Provider 日志。 |
| `gen_ai.request.model` | string | 可获取时 Conditionally Required | 客户端请求的模型。 |
| `gen_ai.response.model` | string | Recommended | 实际用于响应的模型。 |
| `gen_ai.response.finish_reasons` | string[] | Recommended | 生成停止原因，见 [Finish Reasons](#finish-reasons)。 |
| `gen_ai.response.time_to_first_token` | int | 可获取时 Recommended | 从模型原生请求边界到首个 reasoning、text 或 tool-call 输出的时间，单位纳秒；任一边界缺失或无效时省略。 |
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
| `gen_ai.input.messages` | json array | 可获取时 | 发送给模型的完整消息，可能包含敏感内容。开启多模态后，图片以 `parts` 中的 `uri` 出现。 |
| `gen_ai.input.messages_delta` | json array | Recommended | 相比上一条 `llm.request` 新增的输入消息片段。 |
| `gen_ai.input.messages_hash` | string | Recommended | 完整输入上下文 hash，用于去重和缓存分析。 |
| `gen_ai.input.multimodal_metadata` | json array | Opt-In | 输入与工具输出中 `uri` 多模态的摘要列表；条目含 `uri`、`mime_type`，可选 `modality`。开启多模态且这些位置含多模态时写入。 |
| `gen_ai.input.multimodal_metadata_delta` | json array | Opt-In | 本条事件 `messages_delta` 与 `tool.call.result` 中 `uri` 的摘要，条目形态与 `gen_ai.input.multimodal_metadata` 相同。不包含累计 `gen_ai.input.messages`；没有则不写。 |
| `gen_ai.output.messages` | json array | 可获取时 | 模型输出消息，包含文本、reasoning、tool-call parts 和 finish reason，可能包含敏感内容。 |
| `gen_ai.output.multimodal_metadata` | json array | Opt-In | 输出与工具调用中 `uri` 多模态的摘要，条目形态与输入摘要相同；这些位置没有多模态时不写。 |
| `gen_ai.system_instructions` | json array | 可获取时 | `llm.request` 上发送给模型的 system prompt，以 `text` parts 数组表示，可能包含敏感内容。 |
| `gen_ai.tool.name` | string | `tool.call` 和 `tool.result` Required | 工具名称。 |
| `gen_ai.tool.call.id` | string | 可获取时 Recommended | 用于关联 `tool.call` 和 `tool.result` 的工具调用 ID。 |
| `gen_ai.tool.call.exec.id` | string | Recommended | 工具执行侧 ID。 |
| `gen_ai.tool.call.arguments` | json | 可获取时 | 工具调用参数，可能包含敏感内容。 |
| `gen_ai.tool.call.result` | json | 可获取时 | 工具结果 payload，可能包含敏感内容。 |
| `gen_ai.tool.call.duration` | int | Recommended | 使用匹配的 result 边界减去 call 边界得到的正数工具执行耗时，单位毫秒；任一边界缺失或差值非正时省略。 |
| `gen_ai.guardrail.triggered` | boolean | 命中内存拦截判定时 Required | 固定为 `true`。没有 tool call id、没有记录、记录已过期，或 interceptor 未开启时省略。 |
| `gen_ai.guardrail.action` | string | 与 `gen_ai.guardrail.triggered` 同时出现 | 可选值只有 `allow` 和 `block`。`tool.call` 查 `PreToolUse`，`tool.result` 查 `PostToolUse`。被拦截的 Qoder 用户提示补写的 `llm.request` 为 `block`。工具事件查不到时两个字段都不写。 |
| `gen_ai.skill.name` | string | `skill.use` Conditionally Required | 技能或扩展能力名称。 |
| `gen_ai.skill.id` | string | 技能标识可用时 Recommended | 稳定的技能标识。 |
| `gen_ai.skill.description` | string | 技能元数据可用时 Recommended | 技能描述。 |
| `gen_ai.skill.version` | string | 技能元数据可用时 Recommended | 技能版本。 |
| `error.type` | string | 操作以错误结束时 Conditionally Required | 低基数错误类型、错误码、异常类名或 HTTP 状态。 |
| `error.message` | string | `error.type` 存在时 Recommended | 人类可读错误详情。 |
| `http.response.status_code` | int | 模型 HTTP 调用失败时 Recommended | `llm.response` 上失败模型请求的 HTTP 状态码；重试失败和终态失败都会带上。 |
| `agent.channel` | string | Recommended | 请求来源渠道，例如 `ide_plugin`、`web` 或 `api`。 |
| `git.domain` | string | Recommended | 当前 workspace 的 Git 托管域名。 |
| `git.repo` | string | Recommended | 当前 workspace 的 Git 仓库名或 URL。 |
| `git.branch` | string | Recommended | 当前 Git 分支。 |
| `workspace.current_root` | string | Recommended | Git 顶层目录，仅当工作目录是 git 仓库时推断得出。 |
| `workspace.path` | string | Recommended | agent 进程实际运行的工作目录（cwd），与 git 无关。即使目录不是 git 仓库也会带上。 |
| `agent.*` | json | Opt-In | Agent-specific 扩展属性。稳定且高频查询的维度应逐步沉淀为结构化字段。 |

工作目录自动采集覆盖 Claude Code、Codex、Cursor / Cursor CLI、Kiro CLI、MiMo Code、OpenClaw、OpenCode、Pi Coding Agent、Qoder 系列、Qoder Work / Qoder Work CN、Qwen Code CLI、Qwen Work CN 和 WorkBuddy。

## System Instructions（系统提示词）

`gen_ai.system_instructions` 在 `llm.request` 事件上以 `text` parts 数组承载 system prompt，并经过统一脱敏管道。

`hermes` 的 system prompt 取自 `pre_api_request` 观测到的 provider 请求 body，因为 `conversation_history` 从不回放 system 消息。各 provider 形态归一化为同一组 parts：OpenAI 兼容的 `messages[]` 中 role 为 `system` / `developer` 的消息、Responses API 顶层 `instructions`、Anthropic 与 Bedrock 的顶层 `system`（字符串或 block 列表）、Gemini 的 `systemInstruction.parts[].text`。prompt 为空或不存在时不产出该字段。

对 `hermes`，system instructions 仅保留在 `gen_ai.system_instructions` 中，不会合成到 `gen_ai.input.messages` 或 `gen_ai.input.messages_delta`。这样 LLM、AGENT 与 ENTRY span 的业务 turn 输入及 `gen_ai.input.messages_hash` 语义保持不变。

## 多模态消息 Parts

> **实验性。** 多模态 `uri` parts 与 `gen_ai.*.multimodal_metadata` 字段可能调整。

当全局多模态基础设施与 Agent `uploadMode` 已开启时（见 [配置总览](configuration.md#多模态对象存储) 与 [多模态采集](multimodal.md)），消息 `parts` 中的多模态使用对象存储引用，而不是内联 base64：

| `parts[].type` | 说明 |
|----------------|------|
| `text` | 文本内容。 |
| `uri` | 已上传或乐观引用的多模态；含 `uri`、`mime_type`，可选 `modality`（例如 `image`）。 |

`uri` 形如 `oss://bucket/prefix/YYYYMMDD/<sha256>.ext` 或 `sls://project/logstore/YYYYMMDD/<sha256>.ext`。内容 hash 编码在对象路径中。`YYYYMMDD` 按事件的**本地**日历日划分（优先取 `time_unix_ms`），非 UTC，与 Python probe 的对象路径约定一致，便于跨 midnight 边界按日期前缀查询。上传失败时 uri 可能 dangling；Pilot 以 fail-open 方式继续采集文本。

## 自定义 Agent 标识

当支持的 Agent 进程携带以下环境变量启动时，Pilot 会将 Worker 上下文写入当前 Turn：

| 环境变量 | Event 字段 | 说明 |
|----------|------------|------|
| `AGENTTEAMS_WORKER_NAME` | `gen_ai.agent.name`、`resourceAttributes["agentteams.worker.name"]` | 逻辑 Worker 名称；主 Agent 上优先于 Agent 原生名称。 |
| `AGENTTEAMS_INSTANCE_ID` | `resourceAttributes["agentteams.instance.id"]` | 当前 Worker 运行实例；不会覆盖 `gen_ai.agent.id`。 |

Claude Code、Qoder、Codex、OpenCode、Pi Coding Agent、DeepSeek Harness、MiMo Code、Qwen Code CLI 和 Cursor CLI 支持上述两个变量。OpenClaw 和 Hermes Agent 仅支持 `AGENTTEAMS_WORKER_NAME`，暂不读取 `AGENTTEAMS_INSTANCE_ID`。Cursor Desktop 不读取这组变量。未设置变量时，现有事件字段和名称回退行为不变。Pilot 只采集上述固定白名单字段；其他 `AGENTTEAMS_*` 变量不会进入事件或 OTLP Resource。

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
| `bytedance.doubao` | 豆包工作原生服务；客户端轮次观测不表示已采集模型内部调用。 |
| `groq` | Groq。 |
| `mistral_ai` | Mistral AI。 |
| `cohere` | Cohere。 |
| `perplexity` | Perplexity。 |
| `x_ai` | xAI Grok。 |
| `ibm.watsonx.ai` | IBM Watsonx AI。 |

如果以上值都不适用，使用小写 dotted provider 名称，例如 `baidu.ernie` 或 `zhipu.chatglm`。

## 豆包工作客户端轮次元数据

实验性 `doubao-work` 事件与 OTLP Resource 包含 `loongsuite.doubao_work.observation_scope=client_message`、
`loongsuite.doubao_work.business_outcome=unknown` 和 `loongsuite.doubao_work.client_outcome`
（`received`、`ended`、`error` 或 `cancelled`）。客户端结束不表示业务成功，也不是模型 finish reason。
见[支持范围与配置](doubao-work.md)。

## Finish Reasons

| 值 | 说明 |
|----|------|
| `stop` | 模型正常生成结束。 |
| `length` | 达到最大输出 token 限制。 |
| `tool_calls` | 模型触发工具调用。 |
| `content_filter` | 内容安全过滤停止生成。 |
| `end_turn` | 模型结束当前轮次。 |
| `cancelled` | 用户中断生成，不表示 Provider 或 Agent 错误。 |
| `error` | 单次物理模型请求失败。对 Claude Code，中间的 `error` 不结束 turn；最终失败还会带 `gen_ai.turn.end=true`。 |
