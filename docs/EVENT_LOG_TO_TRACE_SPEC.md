# Event Log → GenAI Trace 转换规范

> **目的**：本规范定义 AI Agent 插件 / loongsuite-pilot 在产出"事件日志（event log）"时**必须遵守的约束**，使得 `@loongsuite/otel-util-genai` 能把事件日志**确定性地**转换为符合 ARMS GenAI 语义规范的 OTel trace。
>
> **读者**：各 Agent 插件（claude-code / codex / qoder 系列 / cursor / ...）的开发者、loongsuite-pilot 的 input / flusher 维护者。
>
> **强制性**：本规范中标注 **[MUST]** 的条款是硬约束——违反会导致 trace 结构错误、数据丢失或无法被 ARMS GenAI UI 渲染。标注 **[SHOULD]** 的是强烈建议。标注 **[MAY]** 的是可选增强。
>
> **配套规范**：
> - 事件日志字段定义：`loongsuite-pilot/docs/ai_event_schema.md`
> - trace 目标语义：`arms/semantic-conventions/arms_docs/trace/gen-ai.md`
> - 消息体 JSON Schema：`arms/.../gen-ai_messages_schema/gen-ai-{input,output}-messages.json`

---

## 0. 一句话核心

> **事件日志是"中间表示"。trace 不是插件直接写的，而是由 util-genai 从事件日志确定性地推导出来的。**
> 因此：**trace 长什么样，完全由事件日志的字段决定。事件日志错了，trace 一定错——且转换器不会、也不应该去"猜"或"补救"。**

转换器只做一件事：**按事件日志里携带的分组键（trace_id / turn.id / step.id / tool.call.id / response.id）把扁平事件流重组成 span 树**。它不访问任何外部数据源，不做业务推断。所以上游必须把这些键写正确。

---

## 1. 心智模型：5 类 span 与事件的对应关系

ARMS GenAI trace 是一棵 5 层 span 树：

```
ENTRY  (一次用户输入的入口)                         ← 每个 turn 一个
  └── AGENT  (agent 本次调用)                       ← 每个 turn 一个
        └── STEP  (一轮 ReAct: 思考→行动→观察)      ← 每个 step.id 一个
              ├── LLM   (一次 LLM API 调用)         ← 每对 llm.request+llm.response 一个
              └── TOOL  (一次工具执行)              ← 每对 tool.call+tool.result 一个
```

事件日志是**扁平的事件流**，每条事件用 `event.name` 标识语义。转换器把它们重组成上面的树：

| event.name | 角色 | 映射到 |
|---|---|---|
| `llm.request` | 一次 LLM 调用的请求侧 | 与 `llm.response` 配对 → 1 个 **LLM span** |
| `llm.response` | 一次 LLM 调用的响应侧 | 同上 |
| `tool.call` | 一次工具调用的发起 | 与 `tool.result` 配对 → 1 个 **TOOL span** |
| `tool.result` | 一次工具调用的结果 | 同上 |
| 其它（`skill.use` / `tool.approve` / `other`）| 暂不支持 | 被忽略（会产生 warning）|

**ENTRY / AGENT / STEP 这三类"容器 span" 在事件流里没有对应的事件**——它们由转换器根据 `turn.id` / `step.id` 分组**自动生成**。这意味着：上游不需要、也不应该为它们写事件；上游只需要保证每条叶子事件（llm/tool）带对正确的 `turn.id` / `step.id`。

---

## 2. 分组键：trace 结构的根基 [MUST]

这是整个规范**最重要**的部分。trace 结构 100% 由以下 4 个分组键决定：

| 键 | 决定 | 规则 |
|---|---|---|
| `trace_id` | 一个 OTel trace 的 ID | [MUST] 同一 turn 内所有事件共享**同一个** trace_id |
| `gen_ai.turn.id` | 一个 trace 的边界（= 1 个 ENTRY/AGENT）| [MUST] 一次用户输入 → 唯一一个 turn.id；turn 内所有事件共享 |
| `gen_ai.step.id` | 一个 STEP span | [MUST] 同一次 LLM 调用及其触发的工具，共享同一个 step.id |
| `gen_ai.tool.call.id` | TOOL 配对键 | [MUST] 同一次工具调用的 `tool.call` 和 `tool.result` 共享 |
| `gen_ai.response.id` | LLM 配对键 | [SHOULD] 同一次 LLM 调用的 `llm.request` 和 `llm.response` 共享 |

### 2.1 [MUST] 一次用户输入 = 一个 turn.id = 一个 trace

转换器按 `gen_ai.turn.id` 分组，**每个 turn 产出一个独立 trace**（一个 ENTRY + 一个 AGENT）。

- 一次用户输入（从用户提问到 agent 给出最终答复）期间的**所有** LLM 调用、工具调用，无论中间经过多少轮 ReAct，**都必须**属于同一个 turn.id。
- 下一次用户输入才开启新的 turn.id。

**分组键回退顺序**（转换器实现）：
1. `gen_ai.turn.id` 存在 → 用它分组
2. 否则用 `gen_ai.session.id` 分组（整个 session 被当作一个 turn —— **这几乎总是错的**，见下方反例）

> **[MUST] 不要缺失 turn.id**。缺了它，整个 session 的多次对话会被合并成一个巨大的 trace。

### 2.2 [MUST] 一个 turn 内 trace_id 必须唯一且一致

- turn 起始时分配一次 trace_id（32 位小写 hex），turn 内所有事件复用。
- **禁止**在 turn 内重新生成 trace_id（典型 bug：每次工具往返或每次重新解析 transcript 就重新生成）。
- 如果同一 turn 内出现多个不同 trace_id，转换器只取第一个并 warning。
- 如果完全不提供 trace_id，转换器会让 OTel SDK 自动分配——但这会导致**事件日志（SLS）和 trace（ARMS）无法通过 trace_id 互相跳转关联**。

### 2.3 [MUST] step.id 按"LLM 调用边界"切分，不是按工具切分

**STEP 的语义 = 一轮 ReAct = 1 次 LLM 决策 + 该决策触发的 0~N 个工具执行。**

正确的切分规则：
- 每次**新的 LLM 调用**开启一个新 step.id。
- 这次 LLM 决策如果要调用工具（可能并行调多个），这些工具**全部**属于当前 step.id。
- 工具结果返回后，agent 再次调用 LLM —— 这次 LLM 调用开启**下一个** step.id。

```
step_1:  LLM(决定调用 ToolA, ToolB)  →  ToolA  →  ToolB
step_2:  LLM(看到结果, 决定调用 ToolC)  →  ToolC
step_3:  LLM(最终回答, 无工具)
```

**[MUST] 不要按工具边界切 step**（典型 bug）。一次 LLM 决策并行调 3 个工具时，这 3 个工具属于同一个 step，不是 3 个 step。最后一次"无工具的纯回答" LLM 调用，必须独占一个 step。

**结果约束**：正确切分后，**一个 turn 内 STEP 数 == LLM 调用数**（参考 claude-code 实测：每个 trace STEP 数严格等于 LLM 数）。

**推荐格式**：`<turn.id>:s<N>`（N 从 1 递增），如 `sess123:t2:s1`。

### 2.4 [SHOULD] react.round / finish_reason

- `gen_ai.react.round`：从 1 开始的轮次号。若不提供，转换器尝试从 step.id 末尾数字解析（如 `...:s3` → 3）。解析正则为 `/(?:^|[_:s])(\d+)$/`，只识别 `:sN`、`_N` 或纯数字结尾的 step.id 后缀。[SHOULD] 显式提供更可靠。
- `gen_ai.react.finish_reason`：本轮结束原因。若不提供，转换器从本 step 最后一条 `llm.response` 的 `finish_reasons` 推导。

---

## 3. 字段映射总表

转换器从事件读取以下字段，映射到 span 属性。**[MUST]** 字段缺失会导致 trace 不合规。

### 3.1 公共字段（所有事件都应携带，会注入到该 turn 的所有 span）[MUST]

| 事件字段 | trace span 属性 | 说明 |
|---|---|---|
| `trace_id` | （决定 span 的 traceId）| 见 §2.2 |
| `gen_ai.session.id` | `gen_ai.session.id` | [MUST] 注入所有 span |
| `user.id` | `gen_ai.user.id` | [MUST] 注入所有 span |
| `gen_ai.agent.type` | `gen_ai.agent.name`（回退源）| 若无 `gen_ai.agent.name` 则用 `agent.type` |
| `gen_ai.agent.name` | `gen_ai.agent.name` | 优先于 agent.type |
| `gen_ai.turn.id` | （决定 trace 分组）| 见 §2.1 |
| `gen_ai.step.id` | （决定 STEP 分组）| 见 §2.3 |

> **注意**：`gen_ai.agent.name` / `gen_ai.user.id` / `gen_ai.session.id` 是 ARMS **公共属性**，转换器会注入到 ENTRY/AGENT/STEP/LLM/TOOL **每一个** span 上。上游只要在每条事件上带好这几个字段即可。

### 3.2 LLM span（来自 `llm.request` + `llm.response` 配对）

| 事件字段 | 来源事件 | LLM span 属性 | 等级 |
|---|---|---|---|
| `gen_ai.provider.name` | request/response | `gen_ai.provider.name` | [MUST] |
| `gen_ai.request.model` | request | `gen_ai.request.model` | [MUST] |
| `gen_ai.response.model` | response | `gen_ai.response.model` | [SHOULD] |
| `gen_ai.response.id` | response | `gen_ai.response.id` + 配对键 | [SHOULD] |
| `gen_ai.response.finish_reasons` | response | `gen_ai.response.finish_reasons` | [SHOULD] |
| `gen_ai.usage.input_tokens` | response | `gen_ai.usage.input_tokens` | [SHOULD] |
| `gen_ai.usage.output_tokens` | response | `gen_ai.usage.output_tokens` | [SHOULD] |
| `gen_ai.usage.cache_read.input_tokens` | response | 同名 | [SHOULD] |
| `gen_ai.usage.cache_creation.input_tokens` | response | 同名 | [SHOULD] |
| `gen_ai.input.messages` / `_delta` | request | `gen_ai.input.messages` | [SHOULD] |
| `gen_ai.output.messages` | response | `gen_ai.output.messages` | [SHOULD] |

> `gen_ai.usage.total_tokens` 由转换器自动计算（input + output），上游不需要算。

> **Model fallback 链**（response-only 场景，0.1.0-beta.2+）：当 `llm.request` 缺失时，`gen_ai.request.model` 按以下顺序回退：`request["gen_ai.request.model"]` → `response["gen_ai.request.model"]` → `response["gen_ai.response.model"]` → null。这保证 response-only 的 LLM span name 不会显示为 `chat unknown`。

> **[MUST] provider 与 model 必须真实匹配**。常见 bug：插件硬编码 `provider.name=anthropic`，但实际接的是 qwen 模型（`model=qwen-max`）。这会导致 ARMS 按 provider 聚合时归错类。provider 必须反映实际调用的模型服务。

### 3.3 TOOL span（来自 `tool.call` + `tool.result` 配对）

| 事件字段 | 来源 | TOOL span 属性 | 等级 |
|---|---|---|---|
| `gen_ai.tool.name` | call | `gen_ai.tool.name` | [MUST] |
| `gen_ai.tool.call.id` | call/result | `gen_ai.tool.call.id` + 配对键 | [MUST] |
| `gen_ai.tool.type` | call | `gen_ai.tool.type`（默认 `function`）| [MAY] |
| `gen_ai.tool.call.arguments` | call | `gen_ai.tool.call.arguments` | [SHOULD] |
| `gen_ai.tool.call.result` | result | `gen_ai.tool.call.result` | [SHOULD] |

### 3.4 AGENT span（转换器自动聚合，无需上游写事件）

转换器从 turn 内所有事件自动生成 AGENT span，并**聚合** token：

- `gen_ai.usage.input_tokens` = turn 内所有 `llm.response` 的 input_tokens 之和
- output / cache_read / cache_creation 同理累加
- `gen_ai.agent.name` / `gen_ai.agent.id` / `gen_ai.request.model` 取自 turn 内事件

> ⚠️ **[MUST] 拆分 response 时只在一条上携带 token，另一条置 0**。AGENT 的 token 聚合直接遍历原始 event log 中的 `llm.response`（未经 response.id 合并），如果拆开的两条 response 都携带相同的非零 token 值（如都复制了 `input_tokens=100`），AGENT 层会累加成 200，而 LLM span 合并后只取到 100——造成 AGENT 与 LLM 的 token 数不一致。

### 3.5 ENTRY span（转换器自动生成）

- `gen_ai.input.messages` = 用户输入（见 §5 user-hook 机制）
- `gen_ai.output.messages` = turn 内最后一条 `llm.response` 的 output

---

## 4. 配对规则

### 4.1 LLM 配对 [MUST 一对一]

在**同一个 step 内**，转换器把 `llm.request` 与 `llm.response` 配对成一个 LLM span：

1. 若两者有相同的 `gen_ai.response.id` → 按 ID 配对（最可靠）。
2. 否则按时间顺序配对（第 N 个 request 配第 N 个 response）。
3. 落单的 request 或 response → 产生 warning，生成一个"单边" LLM span（时长为 0）。

> **[MUST] 一次 LLM API 调用 = 一个 llm.request + 一个 llm.response = 一个 LLM span。**

### 4.2 [MUST] thinking 和 text 不能拆成两条 llm.response

这是 qoder / cursor 系列最常见的 bug。一次 LLM 调用如果同时产出了 reasoning（思考）和 text（回答），它们是**同一次调用的两个 part**，必须放在**同一条** `llm.response` 的 `gen_ai.output.messages` 里：

✅ **正确**（一条 response，多 part）：
```json
{
  "event.name": "llm.response",
  "gen_ai.response.id": "msg_123",
  "gen_ai.output.messages": [
    {
      "role": "assistant",
      "parts": [
        { "type": "reasoning", "content": "用户在问 X，我先想想..." },
        { "type": "text", "content": "答案是 Y。" }
      ],
      "finish_reason": "stop"
    }
  ]
}
```

❌ **错误**（拆成两条 response）：
```json
{ "event.name": "llm.response", "gen_ai.response.id": "msg_123", "gen_ai.output.messages": [{"role":"assistant","parts":[{"type":"reasoning","content":"..."}]}] }
{ "event.name": "llm.response", "gen_ai.response.id": "msg_123", "gen_ai.output.messages": [{"role":"assistant","parts":[{"type":"text","content":"..."}]}] }
```

拆开会导致：同一次调用生成 2 个 LLM span、token 错位或丢失、ARMS UI 上看到重复/残缺的调用。

> **[MUST] 最佳实践仍然是源头合并**——在事件日志层面就把 reasoning 和 text 放进同一条 `llm.response` 的多 part。
>
> **兼容路径（0.1.0-beta.2+）**：如果上游短期无法从源头合并，至少保证拆开的多条 `llm.response` 带**相同的 `gen_ai.response.id`**。转换器在配对前会自动把同一 step 内相同 `response.id` 的多条 response **合并成一条**（parts 按时间顺序拼接，token 取有值的那条，model/finish_reason 取最后一条非空值，endTime 取最晚一条的时间）。合并后再与 request 配对成单个 LLM span。
>
> 注意：此兼容路径依赖 `response.id` 正确——如果两条拆开的 response 的 `response.id` 不同或缺失，转换器仍会生成 2 个独立 LLM span。
>
> **合并策略细节**（0.1.0-beta.2+）：
>
> | 字段 | 合并规则 |
> |---|---|
> | `gen_ai.output.messages` parts | 按 `time_unix_nano` 顺序拼接所有 part |
> | `role` / `finish_reason` | 取最后一条 response 的最后一个 message 的值 |
> | token 字段（`input/output/cache_*`）| **取首个非零值（不累加）** |
> | `gen_ai.response.model` | 取最后一个非 `unknown` 的值 |
> | span startTime | 取组内最早的 `time_unix_nano` |
> | span endTime | 取组内最晚的 `time_unix_nano` |
>
> **[MUST]** 因 token 取首个非零值而非累加：拆分 response 时**只在一条上携带 token 值，另一条置 0**（见 §3.4 AGENT 双算风险说明）。

### 4.3 TOOL 配对 [MUST]

同一 step 内，按 `gen_ai.tool.call.id` 配对 `tool.call` 和 `tool.result`。同一次工具调用两端**必须**带相同的 `tool.call.id`。

### 4.4 Subagent 嵌套（0.1.0-beta.5+）[MAY]

当 AI Agent 的一次工具调用触发了子 agent（如 Claude Code 的 Agent tool、Cursor 的 subagent），子 agent 的 LLM/TOOL 调用可以嵌套在父 TOOL span 下，形成：

```
ENTRY → AGENT → STEP → LLM + TOOL(Agent)
                                  └── AGENT(child) → STEP → LLM + TOOL
```

**协议字段**：子 session 的 records 必须在每条事件上携带：

| 字段 | 值 | 说明 |
|---|---|---|
| `gen_ai.agent.scope` | `"subagent"` | [MUST] 标识此 record 属于子 session |
| `gen_ai.subagent.parent_tool_call.id` | 父 TOOL 的 `gen_ai.tool.call.id` | [MUST] 关联到哪个 TOOL span 下 |

**转换器行为**：
- 标记为 `subagent` 的 records 被从父级 turn 中分离，**不参与**父级 ENTRY/AGENT 的 token 聚合和 output.messages 构建。
- 按 `parent_tool_call.id` 分组后，在对应 TOOL span 内部创建子 AGENT → STEP → LLM/TOOL 子树。
- 子 agent 的 `agentName` 从子 records 的 `gen_ai.agent.type` / `agent.name` 取值。
- TOOL span 的 startTime/endTime 自动扩展以包裹子 agent 时间范围。
- 子 agent **不生成 ENTRY span**（子 agent 不是用户入口）。
- 当前支持 **1 层嵌套**（子 agent 的 TOOL 下不再嵌套孙 agent）。

**向后兼容**：不携带 `gen_ai.agent.scope` 字段的 records 完全走原有路径，行为不变。

**示例**：

```jsonc
// 子 session 的 llm.request（注意 scope + parent_tool_call.id）
{
  "event.name": "llm.request",
  "gen_ai.agent.scope": "subagent",
  "gen_ai.subagent.parent_tool_call.id": "call-agent-001",
  "gen_ai.step.id": "child:s1",
  "gen_ai.agent.type": "search-agent",
  "gen_ai.request.model": "claude-haiku",
  // ... 其余标准字段
}
```

---

## 5. user-hook 机制：用户输入不是 LLM 调用 [MUST 理解]

很多插件用 `llm.request` 来标记"用户提交了 prompt"。但**用户提交 prompt 本身不是一次 LLM API 调用**——它只是这个 turn 的输入。

转换器的处理规则：一条 `llm.request` 如果**同时满足**：
- 缺 `gen_ai.step.id`
- 缺 `gen_ai.request.model`
- 在本 turn 内没有可配对的 `llm.response`（orphan）

→ 它被识别为 **user-hook 事件**，其 `gen_ai.input.messages` 内容被合并进 **ENTRY span 的 input.messages**，**不生成独立的 LLM span**。

### 5.1 [MUST] 上游的正确做法

**做法 A（[MUST] 推荐，0.1.0-beta.3+）**：用户输入发 `event.name = "other"`，在 `gen_ai.input.messages_delta`（或 `gen_ai.input.messages`）字段携带用户原始 prompt。转换器会提取该字段归并到 ENTRY/AGENT 的 `input.messages`，**不会**为 `other` 事件生成任何 span。没有 messages 字段的 `other` 事件（如 cursor 的 stop 信号）会被静默丢弃。

```json
{
  "event.name": "other",
  "gen_ai.input.messages_delta": [
    { "role": "user", "parts": [{ "type": "text", "content": "用户输入内容" }] }
  ],
  "gen_ai.session.id": "...", "gen_ai.turn.id": "...", "trace_id": "...",
  "user.id": "...", "gen_ai.agent.type": "..."
}
```

**做法 B（⚠️ 已过期，准备废弃）**：用户输入仍发 `llm.request`，但保证它缺 step.id + 缺 model。转换器仍能识别为 user-hook 并归并到 ENTRY，但会产出一条 deprecation warning（`"Consider migrating to event.name='other'"`）。**新插件必须用做法 A；已有插件应尽快迁移。**

> **[MUST] 真实的 LLM 调用必须有 step.id + model**，这样才能和"用户输入伪请求"区分开。如果真实 LLM 调用也缺 step.id+model，会被误判为 user-hook 而丢失。

> **[MUST] 真实 LLM 调用（带 step.id + model 的 `llm.request`）的 `gen_ai.input.messages` 或 `_delta` 必须自带完整或增量的用户消息**。user-hook 事件的 delta 只被归并到 ENTRY/AGENT 的 `input.messages`，**不会**回填到后续 LLM span 的 `gen_ai.input.messages`。如果上游只在 user-hook 事件里发了用户 prompt，而真实 `llm.request` 的 delta 为空，LLM span 上就会看不到用户输入。

---

## 6. 时间字段 [MUST]

- 所有事件**必须**有 `time_unix_nano`（Unix 纳秒，字符串或数字皆可）。
- [MUST] 必须是**事件实际发生时刻**，不是采集时刻（采集时刻用 `observed_time_unix_nano`）。
- LLM span 的时长 = `llm.response.time_unix_nano` − `llm.request.time_unix_nano`。若 request 缺失，时长退化为 0。
- TOOL span 的时长 = `tool.result.time_unix_nano` − `tool.call.time_unix_nano`。

> **[MUST] llm.request 和 llm.response 的时间戳不能相同**。若上游只能拿到一个时刻（如从 transcript 事后解析），会导致 LLM span 时长为 0，无法看出真实耗时。应尽量提供真实的请求开始时刻。

---

## 7. 消息体格式 [MUST]

`gen_ai.input.messages` / `gen_ai.output.messages` 必须遵循 ARMS 消息 JSON Schema：**嵌套 parts 结构**。

✅ **正确**：
```json
[{ "role": "user", "parts": [{ "type": "text", "content": "你好" }] }]
```

❌ **错误**（OpenAI 平铺格式，content 会丢失）：
```json
[{ "role": "user", "content": "你好" }]
```

part 的 `type` 取值：`text` / `reasoning` / `tool_call` / `tool_call_response` / `blob` / `uri` / `file`。

`gen_ai.input.messages_delta`（增量）：若上游用增量模式（每次只发本轮新增消息），转换器会在**整个 turn 内按时间顺序累积**还原完整上下文。[MUST] delta 必须是 turn 内单调追加，不能乱序或重发。

---

## 8. 完整端到端示例

### 8.1 输入：事件日志（一次对话，1 个 turn，2 个 step，含 1 次工具调用）

```jsonc
// 事件 1：用户输入（user-hook：缺 step.id + 缺 model）
{
  "time_unix_nano": "1780000000000000000",
  "event.id": "e1", "event.name": "llm.request",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.provider.name": "qwen",
  "gen_ai.input.messages_delta": [
    { "role": "user", "parts": [{ "type": "text", "content": "列出当前目录的文件" }] }
  ]
}

// 事件 2：step_1 真实 LLM 请求（有 step.id + model）
{
  "time_unix_nano": "1780000001000000000",
  "event.id": "e2", "event.name": "llm.request",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s1",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
  "gen_ai.input.messages_delta": [
    { "role": "user", "parts": [{ "type": "text", "content": "列出当前目录的文件" }] }
  ]
}

// 事件 3：step_1 LLM 响应（reasoning + tool_call 同一条，多 part）
{
  "time_unix_nano": "1780000002000000000",
  "event.id": "e3", "event.name": "llm.response",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s1",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max", "gen_ai.response.model": "qwen-max",
  "gen_ai.response.id": "msg-aaa", "gen_ai.response.finish_reasons": ["tool_calls"],
  "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 30,
  "gen_ai.output.messages": [
    { "role": "assistant",
      "parts": [
        { "type": "reasoning", "content": "用户要列目录，我调用 Bash。" },
        { "type": "tool_call", "id": "call-1", "name": "Bash", "arguments": { "command": "ls" } }
      ],
      "finish_reason": "tool_calls" }
  ]
}

// 事件 4：step_1 工具调用
{
  "time_unix_nano": "1780000002500000000",
  "event.id": "e4", "event.name": "tool.call",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s1",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.tool.name": "Bash", "gen_ai.tool.call.id": "call-1",
  "gen_ai.tool.call.arguments": { "command": "ls" }
}

// 事件 5：step_1 工具结果（同 tool.call.id）
{
  "time_unix_nano": "1780000003000000000",
  "event.id": "e5", "event.name": "tool.result",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s1",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.tool.name": "Bash", "gen_ai.tool.call.id": "call-1",
  "gen_ai.tool.call.result": { "stdout": "a.txt\nb.txt" }
}

// 事件 6：step_2 LLM 请求（新一轮，新 step.id）
{
  "time_unix_nano": "1780000003500000000",
  "event.id": "e6", "event.name": "llm.request",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s2",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
  "gen_ai.input.messages_delta": [
    { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call-1", "response": "a.txt\nb.txt" }] }
  ]
}

// 事件 7：step_2 LLM 响应（最终回答，无工具）
{
  "time_unix_nano": "1780000004000000000",
  "event.id": "e7", "event.name": "llm.response",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "gen_ai.session.id": "sess-1", "gen_ai.turn.id": "sess-1:t1", "gen_ai.step.id": "sess-1:t1:s2",
  "user.id": "u-100", "gen_ai.agent.type": "demo-agent",
  "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max", "gen_ai.response.model": "qwen-max",
  "gen_ai.response.id": "msg-bbb", "gen_ai.response.finish_reasons": ["stop"],
  "gen_ai.usage.input_tokens": 1260, "gen_ai.usage.output_tokens": 20,
  "gen_ai.output.messages": [
    { "role": "assistant", "parts": [{ "type": "text", "content": "当前目录有 a.txt 和 b.txt。" }], "finish_reason": "stop" }
  ]
}
```

### 8.2 输出：转换后的 trace 结构

```
trace 4bf92f3577b34da6a3ce929d0e0e4736
  ENTRY  enter_ai_application_system          [user.id=u-100, session.id=sess-1, input=用户原话, output=最终回答]
    AGENT  invoke_agent demo-agent            [provider=qwen, model=qwen-max, 聚合 tokens: in=2460 out=50]
      STEP  react step  (round=1)             [来自 step.id=...:s1]
        LLM  chat qwen-max                    [e2+e3 配对, in=1200 out=30, finish=tool_calls, 含 reasoning+tool_call]
        TOOL execute_tool Bash               [e4+e5 配对, call-1, args+result]
      STEP  react step  (round=2)             [来自 step.id=...:s2]
        LLM  chat qwen-max                    [e6+e7 配对, in=1260 out=20, finish=stop, 含 text]
```

要点对照：
- 事件 1（user-hook）**没有**生成 LLM span，它的内容归并进了 ENTRY 的 input.messages。
- 7 条事件 → 7 个 span。注意事件与 span **不是**一一对应：事件 1 不产生独立 span（归并到 ENTRY），ENTRY / AGENT / STEP 是转换器自动生成的容器 span。最终 span 组成 = 4 个容器（ENTRY + AGENT + 2 STEP）+ 2 个 LLM + 1 个 TOOL = 7。
- STEP 数（2）== 真实 LLM 调用数（2）。
- AGENT 的 token 是两个 LLM 的累加（in: 1200+1260=2460，out: 30+20=50）。

---

## 9. 反面教材：真实踩过的坑

下面每条都是实测数据中真实出现过的错误，以及它们造成的后果。

### 9.1 ❌ 缺 turn.id → 整个 session 合并成 1 个巨型 trace
- **现象**：qoder-work 139 events 全无 turn.id，输出 1 个 trace 包含全部对话。
- **修复**：每次用户输入分配唯一 turn.id（可用插件已有的 promptId / request_id 字段映射）。

### 9.2 ❌ 同一 turn 内 trace_id 重复变化 → 一个 trace 出现多个 ENTRY（"双根"）
- **现象**：claude-code 同一 turn 的事件携带 2 个不同 trace_id，转换出"双根" trace。
- **修复**：turn 起始分配一次 trace_id，turn 内复用，绝不重新生成。

### 9.3 ❌ 按工具切 step → STEP 数与 LLM 数不符，并行工具被拆散
- **现象**：把每个 tool.call 当作新 step，导致一次 LLM 决策的多个并行工具被分到不同 step。
- **修复**：按 LLM 调用边界切 step（§2.3）。

### 9.4 ❌ thinking 和 text 拆成两条 llm.response → 重复 LLM span / token 丢失
- **现象**：qoder 系列同一 response.id 出现 2 条 llm.response（一条 reasoning、一条 text），转换出 2 个 LLM span。
- **修复**：合并到同一条 response 的多 part（§4.2）。

### 9.5 ❌ provider 硬编码 / model 不匹配 → ARMS 聚合归错类
- **现象**：claude-code 插件写死 `provider=anthropic`，但用户实际接 qwen 模型。
- **修复**：provider 反映真实模型服务。

### 9.6 ❌ output_tokens=0 / text 丢失 → 只解析了一种 provider 的响应格式
- **现象**：claude-code 接 qwen 时，按 Anthropic 格式解析，output_tokens 和最终 text 回复全丢。
- **修复**：按实际 provider 的响应结构解析 usage 和 message content。

### 9.7 ❌ 消息用 OpenAI 平铺格式 → content 内容丢失
- **现象**：cursor 用 `{role, content}`，转换器找不到 parts，content 丢失。
- **修复**：用嵌套 parts 结构（§7）。

### 9.8 ❌ pilot 重复转换同一 turn → 双根 / span 数翻倍
- **现象**：pilot 的 OtlpTraceFlusher 把同一份 events 转换两次。
- **修复**：turn-buffer 在 flush 时正确清空 + 重入守卫（这是 pilot 侧问题，非插件）。

---

## 10. 上游自检清单

提交事件日志前，对照检查（或用 §11 脚本自动验证）：

### 插件侧
- [ ] 每条事件都有 `time_unix_nano`（真实发生时刻）、`event.id`、`event.name`、`user.id`
- [ ] 每条事件都有 `gen_ai.session.id`、`gen_ai.turn.id`、`trace_id`
- [ ] 一次用户输入内的所有事件共享**同一个** turn.id 和 trace_id
- [ ] 真实 LLM 调用的 `llm.request`/`llm.response` 都有 `gen_ai.step.id` 和 `gen_ai.request.model`
- [ ] step.id 按 LLM 调用边界切（STEP 数 == LLM 调用数）
- [ ] thinking 和 text 在同一条 `llm.response` 里（或至少同 `response.id`）
- [ ] `tool.call` 和 `tool.result` 共享 `gen_ai.tool.call.id`
- [ ] `provider.name` 与实际 `request.model` 匹配
- [ ] `gen_ai.usage.{input,output}_tokens` 真实非零（按实际 provider 格式解析）
- [ ] messages 用嵌套 parts 结构，不是平铺 content
- [ ] 用户输入要么不发 llm.request，要么缺 step.id+model（让它归并到 ENTRY）

### pilot 侧
- [ ] turn-buffer flush 时正确清空，不重复转换同一 turn
- [ ] 不丢失任何 event.name 类型的事件

---

## 11. 自动验收脚本

把事件日志喂给转换器，检查输出：

```bash
# 前置依赖（convertEventLogToReadableSpans 运行时需要）
npm install @loongsuite/otel-util-genai @opentelemetry/sdk-trace-base
```

```bash
node -e "
import('@loongsuite/otel-util-genai').then(async ({ convertEventLogToReadableSpans }) => {
  const fs = await import('fs');
  const records = fs.readFileSync(process.argv[1], 'utf-8').trim().split('\n').map(JSON.parse);
  const r = await convertEventLogToReadableSpans(records);

  // 统计
  const byKind = {};
  for (const s of r.spans) {
    const k = s.attributes['gen_ai.span.kind'];
    byKind[k] = (byKind[k]||0)+1;
  }
  // 0ms span（疑似缺时间戳/缺配对）
  const zero = r.spans.filter(s => {
    const a = s.startTime[0]*1e9+s.startTime[1], b = s.endTime[0]*1e9+s.endTime[1];
    return a === b;
  }).length;

  console.log('events:', records.length, '→ spans:', r.spans.length, 'traces:', r.traceIds.length);
  console.log('span kinds:', byKind);
  console.log('0ms spans:', zero, '(应为 0 或仅孤立事件)');
  console.log('STEP 数:', byKind.STEP||0, ' LLM 数:', byKind.LLM||0, '(两者应相等)');
  console.log('warnings:', r.warnings.length);
  r.warnings.slice(0, 10).forEach(w => console.log('  -', w));
});
" your-event-log.jsonl
```

**合格标准**：
- `traces` 数 == 真实用户对话次数
- `STEP 数 == LLM 数`
- `0ms spans` ≈ 0（除真实中断/孤立场景）
- **非 user-hook 类** `warnings` ≈ 0（除真实中断/孤立场景）。注意：使用 §5 做法 B 的插件每个 turn 会产出一条 `"Treated N llm.request event(s) as user-hook prompt(s)..."` 的 info 级 warning——**这是预期行为，不算违规**。只关注 `Orphan`、`Invalid`、`Inconsistent` 类 warning 是否趋零。
- 每个 span 都有 `gen_ai.agent.name` / `gen_ai.user.id` / `gen_ai.session.id`

---

## 12. 转换器不负责的事（边界澄清）

为避免上游误以为"转换器会兜底"，明确以下事项转换器**不做**：

- ❌ 不访问任何外部数据源（transcript / SQLite / API）补全字段——事件日志缺什么就是什么。
- ❌ 不推断 provider / model —— 缺了就是 `unknown`。
- ✅ **（0.1.0-beta.2+）自动合并**同一 step 内带相同 `response.id` 的多条 `llm.response`（parts 拼接、token 取有值的那条）。但如果 `response.id` 不同或缺失，仍会生成多个独立 LLM span。源头合并仍是最佳实践。
- ❌ 不修正错误的 turn.id / step.id 切分 —— 上游切错，trace 就错。
- ❌ 不去重 pilot 的重复转换。
- ❌ 不处理 `skill.use` / `tool.approve` / `other`（当前版本忽略）。

**一切 trace 质量问题，先查事件日志是否符合本规范。**

---

## 附录：字段速查

| 分类 | 字段 | 等级 | 备注 |
|---|---|---|---|
| 事件级 | `time_unix_nano` | MUST | 真实发生时刻 |
| 事件级 | `event.id` / `event.name` | MUST | |
| 关联 | `trace_id` | MUST | turn 内唯一一致 |
| 关联 | `gen_ai.session.id` | MUST | |
| 关联 | `gen_ai.turn.id` | MUST | 一次用户输入一个 |
| 关联 | `gen_ai.step.id` | MUST | 按 LLM 边界切 |
| 关联 | `gen_ai.tool.call.id` | MUST | tool 配对 |
| 关联 | `gen_ai.response.id` | SHOULD | LLM 配对 |
| 身份 | `user.id` | MUST | |
| 身份 | `gen_ai.agent.type` / `agent.name` | MUST | |
| LLM | `gen_ai.provider.name` / `request.model` | MUST | 必须匹配 |
| LLM | `gen_ai.response.{model,finish_reasons}` | SHOULD | |
| LLM | `gen_ai.usage.{input,output}_tokens` | SHOULD | 真实非零 |
| LLM | `gen_ai.usage.cache_{read,creation}.input_tokens` | SHOULD | provider 支持时 |
| 内容 | `gen_ai.input.messages` / `_delta` | SHOULD | 嵌套 parts |
| 内容 | `gen_ai.output.messages` | SHOULD | thinking+text 同条 |
| 工具 | `gen_ai.tool.name` | MUST | |
| 工具 | `gen_ai.tool.call.{arguments,result}` | SHOULD | |
| 子 agent | `gen_ai.agent.scope` | MAY | `"subagent"` 标识子 session |
| 子 agent | `gen_ai.subagent.parent_tool_call.id` | MAY | 关联父 TOOL 的 call.id |
