## QoderWork LLM Span 采集问题分析

### 问题总览

从 OTLP 调试日志和 Hook JSONL 的实证数据来看，QoderWork 的 LLM Span 存在三个严重缺陷：

| 问题 | 表现 | 根因 |
|------|------|------|
| LLM Span 持续时间 = 0 | `startTimeUnixNano == endTimeUnixNano` | Hook 时间戳取自 transcript 行，同行写入时间完全相同 |
| Token 消耗完全缺失 | `gen_ai.usage.input_tokens` / `output_tokens` 不存在 | Transcript 不含 token 数据，SDK 日志补充链路不工作 |
| 模型名始终为 "auto" | `gen_ai.request.model = "auto"` | Hook 硬编码 "auto"，无 SDK 日志来解析真实模型 |

---

### 问题一：LLM Span 时间戳——start time 和 end time 完全相同

#### 实证数据

从今天的 OTLP 调试日志中，**所有** LLM Span 的持续时间都是 0：

```
LLM | chat auto | start=3886000000 end=3886000000 | dur=0ms
LLM | chat auto | start=3795000000 end=3795000000 | dur=0ms
LLM | chat auto | start=0140000000 end=0140000000 | dur=0ms
...（所有 LLM span 均为 0ms）
```

对应的 Hook JSONL 中，每个 step 的 `llm.request` 和 `llm.response` 的 `time_unix_nano` **完全相同**：

```
line=1 | llm.request  | step=s1 | time_unix_nano=1781160303886000000
line=2 | llm.response | step=s1 | time_unix_nano=1781160303886000000   ← 完全一样！

line=5 | llm.request  | step=s2 | time_unix_nano=1781160313795000000
line=6 | llm.response | step=s2 | time_unix_nano=1781160313795000000   ← 完全一样！
```

#### 根因分析

**时间戳来源——Hook Processor `buildStepEvents()`**

文件：`assets/hooks/qoderwork-hook-processor.mjs` 第 250-324 行

```javascript
// group = 按 parentUuid 分组的 assistant 行（每组 = 一次 LLM 调用）
const firstRow = group[0];
const lastRow = group[group.length - 1];

// llm.request 的 time_unix_nano = firstRow.timestamp
records.push(buildRecord({
    'event.name': 'llm.request',
    time_unix_nano: timestampToUnixNanos(firstRow.timestamp),  // ← 第一行 assistant 的时间
    ...
}));

// llm.response 的 time_unix_nano = lastRow.timestamp
records.push(buildRecord({
    'event.name': 'llm.response',
    time_unix_nano: timestampToUnixNanos(lastRow.timestamp),   // ← 最后一行 assistant 的时间
    ...
}));
```

**为什么 firstRow.timestamp == lastRow.timestamp？**

QoderWork 的 transcript 写入机制：一次 LLM API 调用返回的多个 content block（thinking + text + tool_use）会被批量写入 transcript 文件。这些行共享同一个 `parentUuid`（标识一次 LLM 调用），但它们的 `timestamp` 字段是**同一时刻的写入时间**，不是 API 调用的起止时间。

这意味着：
- `firstRow.timestamp` ≈ `lastRow.timestamp`（同一批写入）
- LLM Span 的 start time ≈ end time → 持续时间 ≈ 0

**语义问题**：即使时间戳不完全相同，也存在语义错误：

| 字段 | Hook 实际用的 | 正确应该用的 |
|------|--------------|------------|
| `llm.request` time | `firstRow.timestamp`（第一个 assistant 行） | **用户消息的时间**（API 请求发出时刻） |
| `llm.response` time | `lastRow.timestamp`（最后一个 assistant 行） | assistant 行时间（近似 API 响应完成时刻） |

`llm.request` 的 start time 取自 assistant 行是错误的——assistant 行是在 API **返回后**才写入的，不是请求发出的时刻。真正的请求时间应该是 user 行的 timestamp。

**QoderWork transcript 原始字段：**

```json
{
  "type": "user",
  "timestamp": 1781160303845,     // ← 用户消息时间（API 请求前）
  "message": { "role": "user", "content": [...] }
}
{
  "type": "assistant",
  "timestamp": 1781160303886,     // ← assistant 行写入时间（API 响应后）
  "parentUuid": "b052fb25-...",   // ← 标识同一次 LLM 调用
  "message": { "role": "assistant", "content": [{"type": "thinking", ...}] }
}
{
  "type": "assistant",
  "timestamp": 1781160303886,     // ← 与上面完全相同！
  "parentUuid": "b052fb25-...",
  "message": { "role": "assistant", "content": [{"type": "text", ...}] }
}
```

#### Converter 的处理

Converter (`converter.js` 第 173-186 行) 的 LLM span 时间计算：

```javascript
const startMs = pair.request
    ? readNanoMs(pair.request["time_unix_nano"])    // ← llm.request 的 time_unix_nano
    : readNanoMs(pair.response["time_unix_nano"]);

let endMs = pair.response
    ? readNanoMs(pair.response["_merged_end_time_unix_nano"]
                  ?? pair.response["time_unix_nano"])  // ← llm.response 的 time_unix_nano
    : startMs;
```

因为 `llm.request.time_unix_nano == llm.response.time_unix_nano`，所以 `startMs == endMs`，LLM span 持续时间 = 0。

---

### 问题二：Token 消耗——完全缺失

#### 实证数据

Hook JSONL 中的所有 `llm.response` 记录都**不包含**任何 token 字段：

```json
{
  "event.name": "llm.response",
  "gen_ai.response.finish_reasons": ["tool_calls"],
  "gen_ai.output.messages": [...],
  // 没有 gen_ai.usage.input_tokens
  // 没有 gen_ai.usage.output_tokens
  // 没有 gen_ai.usage.total_tokens
}
```

OTLP 导出的 LLM span 也没有 token 属性（`gen_ai.usage.input_tokens` 和 `gen_ai.usage.output_tokens` 均为空）。

#### 根因分析

**Token 数据在 QoderWork 的 transcript 中根本不存在。** Hook processor 只处理 transcript 行中的消息内容（type/message），transcript 格式本身不携带 token 用量信息。因此 hook processor 代码中**没有任何** token 相关字段的输出。

**Token 数据的唯一来源是 QoderWork SDK 日志。** SDK 日志中的 `message_delta` 事件携带 `usage.input_tokens` 和 `usage.output_tokens`：

```
[2026-06-09T14:00:00.123] [INFO] [SDK] [QueryHandler] Received message: stream_event
{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1234,"output_tokens":56}}
```

但 SDK 日志的补充链路**不工作**：

1. **SDK 日志文件不存在于预期路径**：预期路径 `~/Library/Application Support/QoderWork/logs/<session>/main.log`，但该目录下只有 `mac-notifier-bootstrap.log`，没有 session 级日志目录
2. **QoderWorkTraceInput 设计正确但无数据可合并**：它通过 FIFO 消费 SDK 日志中的 `SdkMessageData` 来注入 token，但 SDK buffer 始终为空（没有 SDK 日志可读）
3. **降级到纯 Hook JSONL**：没有 SDK 数据时，hook JSONL 直接透传，token 字段全部缺失

**完整 token 数据流断点图：**

```
QoderWork SDK (运行时)
    │
    ├── transcript JSONL ──→ Hook Processor ──→ Hook JSONL
    │   (无 token 数据)         (无 token 输出)     (无 token) ✗
    │
    └── SDK log (message_delta) ──→ QoderWorkTraceInput ──→ 合并到 llm.response
        (有 token 数据)              (文件不存在!) ✗           (永远不会发生) ✗
```

---

### 问题三：模型名始终为 "auto"

#### 实证数据

Hook JSONL 和 OTLP span 中的模型字段：

```
gen_ai.request.model = "auto"
gen_ai.response.model = "auto"
```

#### 根因分析

Hook processor 在 `buildStepEvents()` 中硬编码了模型名：

```javascript
// qoderwork-hook-processor.mjs 第 294 行
'gen_ai.request.model': 'auto',
// 第 315-316 行
'gen_ai.request.model': 'auto',
'gen_ai.response.model': 'auto',
```

QoderWork transcript 行本身不包含模型名，因此 hook processor 只能用 "auto" 占位。

真正的模型名需要通过 SDK 日志中的 `set_model_policy` 事件解析：

```
[2026-06-09T14:00:00.123] [INFO] [SDK] [QueryHandler] Sending control request: set_model_policy
{"chat":"qwen-max","compact":"qwen-flash","scene_model":"qwen-max"}
```

但由于 SDK 日志文件不存在，QoderWorkTraceInput 无法读取 `set_model_policy` 事件，模型名始终为 "auto"。

---

### 各 Pipeline 对比

| Pipeline | Start Time | End Time | Token | Model | 当前状态 |
|----------|-----------|----------|-------|-------|---------|
| **Hook JSONL (QoderWorkInput)** | firstRow.timestamp (= lastRow.timestamp) | lastRow.timestamp | 无 | "auto" | **活跃但不正确** |
| **SDK Log (QoderWorkLogInput)** | message_start event ts | message_delta event ts | message_delta.usage | set_model_policy | **无数据（文件不存在）** |
| **Trace Merge (QoderWorkTraceInput)** | SDK 覆盖 hook | SDK 覆盖 hook | SDK FIFO 注入 | SDK 解析 | **设计正确但 SDK 端为空** |
| **CN Trace (qoder-work-log/trace-input)** | SDK message_start | SDK message_delta | SDK message_delta | SDK set_model_policy | **CN 默认禁用** |

---

### 修复方向

#### 方向 A：修复 Hook Processor 的时间戳（可独立做）

在 `buildStepEvents()` 中，`llm.request` 的 start time 应该使用**用户消息的时间**而不是 firstRow（assistant 行）的时间：

```javascript
// 当前（错误）：
time_unix_nano: timestampToUnixNanos(firstRow.timestamp)

// 修复后：
time_unix_nano: userRow
    ? timestampToUnixNanos(userRow.timestamp)
    : timestampToUnixNanos(firstRow.timestamp)
```

这至少能让 LLM span 有一个合理的 start time（用户发送 prompt 的时刻），end time 用 assistant 行的时间（API 响应完成的时刻）。两者之差就是近似的 LLM 调用持续时间。

但这个方法仍有精度问题——transcript 行时间是写入时间而非 API 时间。

#### 方向 B：修复 SDK 日志路径（解决根本问题）

需要调查 QoderWork 当前版本的 SDK 日志实际写入路径。可能的原因：
1. QoderWork 版本更新后改变了日志路径
2. SDK 日志功能被配置关闭
3. 日志目录结构变化

可以通过在 QoderWork 中执行一次对话，然后用 `find ~/Library/Application\ Support/QoderWork/ -name "*.log" -mmin -5` 来定位实际的日志文件。

#### 方向 C：在 Hook 中拦截 API 响应（更彻底的方案）

如果 QoderWork 的 Hook 机制支持 `PreToolUse` / `PostToolUse` 之外的事件（如 LLM API 请求/响应），可以在 API 层面直接捕获精确的时间戳和 token 数据。但这取决于 QoderWork 的 Hook 事件类型支持。
