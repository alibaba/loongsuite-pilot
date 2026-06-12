## Technical Design

### 1. AGUI Event Processing Enhancement

当前 `transformMessages()` 的 switch 只处理 7 种事件。需扩展至覆盖所有链路关键事件：

```
新增处理的事件类型：
├── STEP_STARTED    → 开始新 step，记录 stepMessageId → stepIndex 映射
├── STEP_FINISHED   → 关闭当前 step
├── TOOL_CALL_ARGS  → 按 toolCallId 累积 delta 字符串作为 arguments
├── TOOL_CALL_RESULT→ 提供完整 result content + is_error 标志
├── RUN_ERROR       → 捕获错误码作为 finish_reason，设置 error.type/message
└── ACTIVITY_SNAPSHOT (activityType: TERMINAL/FILE_WRITE/GREP_SEARCH/...)
                    → 作为 tool.call + tool.result 事件对输出
```

### 2. Step 边界跟踪与 step.id 生成

**数据结构：**

```typescript
interface StepContext {
  stepIndex: number;          // 从 1 递增
  stepId: string;             // `${turnId}:s${stepIndex}`
  stepMessageId: string;      // STEP_STARTED.messageId，用于关联 STEP_FINISHED
  hasToolCalls: boolean;      // 是否包含 TOOL_CALL_START
  startTimestamp: number;
}
```

**算法：**
1. 遇到 `STEP_STARTED` → 创建新 StepContext，stepIndex++
2. 后续所有事件（TEXT_MESSAGE_CONTENT, USAGE, TOOL_CALL_*, ACTIVITY_SNAPSHOT）继承当前 step 的 stepId
3. 遇到 `STEP_FINISHED` → 关闭当前 step
4. **Fallback**：若消息中没有 `STEP_STARTED` 事件（旧版本 wukong-cli），则整个 assistant message 视为单个 step

**step.id 格式：** `${sessionId}:t${turnIndex}:s${stepIndex}`

### 3. finish_reasons 推断逻辑

每个 step 结束时（STEP_FINISHED 或消息末尾），根据 step 内事件推断 finish_reason：

```
if step.hasToolCalls:
    finish_reasons = ["tool_calls"]
elif hasRUN_ERROR:
    finish_reasons = ["stop"]
    error.type = runError.code        (如 "CANCELLED")
    error.message = runError.message
elif isLastStepInMessage:
    finish_reasons = ["end_turn"]
else:
    finish_reasons = ["stop"]
```

### 4. Token 竞态修复

**问题：** 当前代码对每条新 message 立即处理，可能抓到 streaming 中的不完整消息。

**修复策略：** 只处理"已完成"的 assistant 消息。

```typescript
function isMessageComplete(msg: WukongMessage): boolean {
  if (msg.role !== 'assistant') return true;
  if (!msg.events || msg.events.length === 0) return false;
  return msg.events.some(e => 
    e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR'
  );
}
```

在 `doCollect()` 中：
- 只将已完成的消息计入 "已处理" 计数
- 未完成的消息保持在待处理窗口中，下次 poll 时再检查

### 5. TOOL_CALL_ARGS 累积

wukong-cli 可能返回多个 `TOOL_CALL_ARGS` 事件（streaming delta 模式）：

```typescript
const toolArgsAccumulator: Map<string, string> = new Map();

case 'TOOL_CALL_ARGS': {
  const key = evt.toolCallId ?? `idx-${toolStartCount}`;
  const prev = toolArgsAccumulator.get(key) ?? '';
  toolArgsAccumulator.set(key, prev + (evt.delta ?? ''));
  break;
}
```

在 emit tool.call 时，从 accumulator 中取出完整 arguments 字符串。

### 6. ACTIVITY_SNAPSHOT 内建工具采集

将 `ACTIVITY_SNAPSHOT` 事件映射为 tool.call + tool.result 对：

| activityType | tool.name | arguments 来源 | result 来源 |
|---|---|---|---|
| `TERMINAL` | `terminal` | `{command}` | `{output, exit_code}` |
| `FILE_WRITE` | `file_write` | `{path, content_snippet}` | `{status}` |
| `GREP_SEARCH` | `grep_search` | `{query}` | `{matches}` |
| `DIRECTORY_LIST` | `directory_list` | `{path}` | `{entries}` |
| `SKILL` | `skill:${name}` | `{input}` | `{output}` |
| `ARTIFACT` | `artifact` | `{type}` | `{content}` |

每个 ACTIVITY_SNAPSHOT 生成两条事件：
- `tool.call`：timestamp = content.start_time ?? evt.timestamp
- `tool.result`：timestamp = content.finish_time ?? evt.timestamp, duration = finish - start

### 7. Trace/Span ID 生成

为支持 OTLP trace 输出，生成完整 span tree ID：

```
trace_id: 每个 turn 生成一个（crypto.randomBytes(16).toString('hex')）
span_id 分层:
  ├── entrySpanId:  randomBytes(8) — ENTRY span
  ├── agentSpanId:  randomBytes(8) — AGENT span
  ├── stepSpanId:   randomBytes(8) per step — STEP span
  ├── llmSpanId:    randomBytes(8) per LLM call — LLM span
  └── toolSpanId:   randomBytes(8) per tool — TOOL span

parent_span_id 规则:
  llm.request/response → parent = stepSpanId
  tool.call/result     → parent = stepSpanId
```

### 8. 事件处理时序（重构后的 transformMessages）

```
for each assistant message (only complete ones):
  initialize: currentStep = null, stepIndex = 0
  generate: turnTraceId, entrySpanId, agentSpanId
  
  for each event in msg.events:
    switch (event.type):
      STEP_STARTED    → new step context, stepIndex++, generate stepSpanId
      TEXT_MESSAGE_*  → accumulate text
      USAGE           → capture token counts
      FIRST_TOKEN     → capture TTFT metrics
      TOOL_CALL_START → mark step.hasToolCalls, record start time, generate toolSpanId
      TOOL_CALL_ARGS  → accumulate arguments delta
      TOOL_CALL_END   → (legacy: emit tool.result if no TOOL_CALL_RESULT follows)
      TOOL_CALL_RESULT→ emit tool.result with full content
      ACTIVITY_SNAPSHOT→ emit tool.call + tool.result pair
      RUN_ERROR       → capture error info for finish_reason
      RUN_FINISHED    → mark message complete
      STEP_FINISHED   → close step, emit llm.response with inferred finish_reason

  emit llm.request (one per step, with step.id)
  emit remaining events for last step if no STEP_FINISHED
```

### 9. 向后兼容

- 若消息中没有 `STEP_STARTED`/`STEP_FINISHED` 事件（旧版 wukong-cli），回退为当前行为：整个 assistant message 视为单个 step
- 不改变 incremental collection 的 seenCounts 语义（基于 message count）
- 保持现有字段的设置方式不变（host.name, service.name, session.id 等）
