# TraceInput 开发规范

> **目的**：为后续 AI Agent 插件开发提供 TraceInput（多源合并输入）的实现参考。基于 qoder-trace 的实践经验总结。
>
> **读者**：loongsuite-pilot 的 Input / Hook 开发者。
>
> **配套规范**：
> - 事件日志字段定义：`docs/ai_event_schema.md`
> - 事件日志→Trace 转换规范：`docs/EVENT_LOG_TO_TRACE_SPEC.md`
> - ARMS GenAI 语义规范：`arms/semantic-conventions/arms_docs/trace/gen-ai.md`

---

## 1. 什么时候需要 TraceInput

当**单一数据源无法满足 trace 语义规范**的所有字段要求时，需要通过 TraceInput 合并多个数据源。

典型场景：
- 数据源 A 有消息内容但缺 token（如 hook transcript）
- 数据源 B 有 token 但缺内容（如 session segments、SQLite）
- 两者互补，需要合并后才能产出完整的 trace

**判断依据**：对照 `EVENT_LOG_TO_TRACE_SPEC.md` §3 的字段映射表，如果单一 Input 无法同时满足以下 MUST/SHOULD 字段，则需要 TraceInput：

| 字段 | 等级 | 说明 |
|------|------|------|
| `trace_id` | MUST | turn 内唯一一致 |
| `gen_ai.turn.id` / `step.id` | MUST | 正确的分组键 |
| `gen_ai.usage.*_tokens` | SHOULD | token 用量 |
| `gen_ai.input/output.messages` | SHOULD | 消息内容 |
| `time_unix_nano` | MUST | 真实时间戳（非采集时刻） |

---

## 2. 架构模式

### 2.1 合并在 Input 层，不在 Flusher 层

```
✅ 推荐: TraceInput 内部合并
  Input A (source 1) ──┐
                       ├──→ TraceInput 合并 → 完整事件流 → ALL flushers
  Input B (source 2) ──┘

❌ 避免: Flusher 层合并
  Input A → events ──┐
                     ├──→ Flusher 尝试合并 → 时序问题!
  Input B → events ──┘
```

**原因**：
- Flusher 层有结构性时序问题——不同 Input 独立 poll，`finish_reason` 触发 flush 时另一个源的数据可能未到达
- `flushedTurnKeys` 会拒绝后到的事件
- Input 层控制读取时序，可以确保所有源数据就绪后再合并

### 2.2 TraceInput 完全替代，非共存

```
TraceInput 启用时:
  ├── 旧 Input A → 禁用 (互斥守卫)
  ├── 旧 Input B → 禁用 (互斥守卫)
  └── TraceInput  → 唯一活跃 → 输出服务所有 flusher

原因: MultiFlusher 无差别扇出，共存会导致 SLS 收到重复 event
```

### 2.3 互斥守卫模式

```typescript
// orchestrator.ts registerAllInputs()
const traceEnabled = () =>
  this.isAgentGatedEnabled(LISTENER_AGENT_MAP['<agent>-trace']) &&
  this.agentControlManager.resolveEnabled(
    '<agent>-trace',
    listenerCfg['<agent>-trace']?.enabled ?? true,
  );

// 旧 Input: enabled 追加 !traceEnabled() 守卫
enabled: () => !traceEnabled() && <original conditions>,
```

---

## 3. 数据源 Join 策略

### 3.1 精确匹配（优先）

当两个源有共享的唯一 ID 时：

```
Source A: gen_ai.response.id = "msg-123"
Source B: request_id = "msg-123"
Join: response_id ↔ request_id
```

**适用场景**：qoder CLI（transcript 的 `message.id` 与 session segment 的 `request_id` 一致）

### 3.2 近似匹配（退化）

当没有共享 ID 时，用 `session_id + timestamp` 两级匹配：

```
第一级: Turn 匹配（按时间顺序）
  hook turn_id[0] ↔ SQLite request_id[0] (按 MIN(timestamp) 排序)

第二级: Turn 内 LLM 调用匹配（按最近时间戳）
  阈值: 1000ms（实测 0-2ms 差值，最小邻间隔 2215ms）
```

**适用场景**：qoder IDE（transcript 缺 `message.id`，只能通过时间戳关联 SQLite）

### 3.3 阈值选择依据

```
实际差值        推荐阈值        最小邻间隔
0-2ms           1000ms          2215ms
               (500x 宽松)     (1.2x 安全余量)
```

- LLM 调用本身需要数秒，不可能在 1s 内连续出现两次 response
- 阈值应远大于实际差值（容忍各种延迟），远小于邻间隔（不误匹配）

---

## 4. Token 注入规则

### 4.1 只给第一条 response 写 token

当同一 LLM 调用产出多条 `llm.response`（thinking + text 拆分）时：

```
response 1 (thinking): gen_ai.usage.input_tokens = 19495  ← 写
response 2 (text):     gen_ai.usage.input_tokens = 0       ← 置 0
```

**原因**：AGENT span 的 token 聚合直接遍历原始 event log 中的 `llm.response`（不经 `mergeResponsesByResponseId`），如果两条都写非零值会双算。

参考：`EVENT_LOG_TO_TRACE_SPEC.md` §3.4

### 4.2 未匹配的 response 统一置 0

```typescript
// 未匹配到 token 源的 llm.response，token 设为 0（非 undefined）
// 确保 AGENT 聚合计数一致
entry['gen_ai.usage.input_tokens'] = 0;
```

### 4.3 时间戳保护

当 hook processor 已使用 progress 事件设置了精确时间戳时，enricher 不应覆盖：

```typescript
const currentTs = entry.time_unix_nano;
const observedTs = entry.observed_time_unix_nano;
// 仅在 time == observed（旧 processor 的标记）时覆盖
if (!currentTs || currentTs === observedTs) {
  entry.time_unix_nano = tokenSource.timestamp;
}
```

---

## 5. Hook Processor 设计要点

### 5.1 利用 Hook 事件获取精确 LLM 调用时间

Agent transcript 本身通常只记录"LLM 输出了什么"，不直接提供 LLM 调用的 start/end 时间。但可以通过以下方式获取精确时间：

**方式 A：Agent 自身的 hook 事件**（推荐）

大多数 Agent 支持多个生命周期 hook（如 PreToolUse、PostToolUse、UserPromptSubmit 等）。这些 hook 的触发时间可以作为 LLM 调用的时间锚点：

```
UserPromptSubmit 时间  → 第一次 LLM 调用的开始时间
PostToolUse 时间       → 下一次 LLM 调用的开始时间（工具执行完毕 = LLM 重新被调用）
PreToolUse 时间        → 上一次 LLM 调用的结束时间（LLM 输出到达并决定调用工具）
```

不同 Agent 的 hook 事件来源不同：
- **qoder**：transcript 内的 `progress` 行记录了各 hook 的执行时间戳
- **claude-code**：`claude-code-hook-processor.mjs` 的 `alignWithHookEvents` 使用 `user_prompt_submit`、`pre_tool_use`、`post_tool_use` hook 事件校准时间
- **codex**：`codex-hook-processor.mjs` 的 `react-step-builder.mjs` 从 tool start/end 时间推导 `llm_start_time` 和 `llm_end_time`

**方式 B：时间戳分布推算**（退化）

当 hook 事件不可用时，可以从 transcript 的时间范围均匀分配：

```javascript
// claude-code 的 assignTimestamps: 在 startTime 和 stopTime 之间均匀分配
const interval = duration / (llmCalls + 1);
request_start_time = responseTimestamp - min(interval * 0.5, 1000);
```

### 5.2 LLM 调用边界检测

确定哪些 content blocks 属于同一次 LLM 调用：

```
方式 1: 共享 response.id（最可靠）
  同一 message.id 的 thinking + text + tool_use = 同一 LLM 调用

方式 2: 时间戳接近度（无 response.id 时）
  <200ms 内的连续 assistant blocks = 同一 LLM 调用

方式 3: Hook 事件分隔（有 progress/hook 事件时）
  PostToolUse → [assistant blocks] → PreToolUse = 一次 LLM 调用
```

### 5.3 多 Parts 合并

同一 LLM 调用的 thinking + text + tool_use 应合并为一条 `llm.response` 的多 parts：

```json
{
  "gen_ai.output.messages": [{
    "role": "assistant",
    "parts": [
      { "type": "reasoning", "content": "..." },
      { "type": "text", "content": "..." },
      { "type": "tool_call", "id": "call-1", "name": "Bash", "arguments": {...} }
    ],
    "finish_reason": "tool_calls"
  }]
}
```

**避免**每个 content block 独立发一条 event——这会导致转换器产出多个 LLM span。

### 5.4 合成 llm.request 事件

Hook transcript 通常只记录 LLM 的输出（response），不记录输入（request）。需要合成 llm.request：

| Step | llm.request 来源 |
|------|-----------------|
| Step 1 | user prompt（第一个 user 行的内容） |
| Step N | 前一步的 tool results（`tool_call_response` parts） |

**时间戳**：
- llm.request: PostToolUse/UserPromptSubmit 时间（LLM 调用开始）
- llm.response: PreToolUse 时间（LLM 输出到达）

### 5.5 User-Hook 事件格式

用户输入不是 LLM 调用，必须让转换器识别为 user-hook：

```
✅ 正确: event.name='llm.request', 无 step.id, 无 model
   → 转换器归并到 ENTRY.input.messages，不产生 LLM span

❌ 错误: event.name='llm.request', step.id='s1', model='unknown'
   → 转换器当作真实 LLM 请求，产生幽灵 'chat unknown' span
```

### 5.6 非交互模式 Transcript 写入 Race Condition

某些 Agent 在非交互模式下（如 `qodercli --print`），Stop hook 触发时 transcript 尚未完全写入。

**解决方案**：后台延迟重试

```javascript
// 检测: transcript 不完整（行数少且无 last-prompt 结尾标记）
if (parsed.length < MIN_COMPLETE_LINES && lastLine.type !== 'last-prompt') {
  // spawn 后台子进程，延迟 5s 后重新处理
  spawnDelayedRetry(agentId, transcriptPath, sessionId);
  return; // 立即返回，不阻塞 Agent 进程
}
```

**关键约束**：不能在 hook 内 sleep 等待——Agent 进程在 hook 返回后才继续写入 transcript，形成死锁。

---

## 6. 输出事件验收标准

TraceInput 产出的事件必须满足：

```
每条事件:
  [MUST] trace_id      — turn 内唯一一致（32 hex chars）
  [MUST] turn.id       — 一次用户输入一个
  [MUST] step.id       — 按 LLM 调用边界切分
  [MUST] session.id    — 会话标识
  [MUST] user.id       — 用户标识
  [MUST] agent.type    — agent 类型
  [MUST] time_unix_nano — 真实发生时刻

llm.request:
  [MUST] step.id + model — 与 llm.response 配对
  [SHOULD] input.messages_delta — 本轮输入

llm.response:
  [SHOULD] output.messages — 嵌套 parts 格式，含 reasoning+text+tool_call
  [SHOULD] usage.{input,output}_tokens — 真实非零
  [SHOULD] response.id — 与 request 配对
  [SHOULD] finish_reasons

结构约束:
  STEP 数 == LLM 调用数
  0ms spans ≈ 0
  每个 LLM span 有 input + output + token
```

验收脚本：`EVENT_LOG_TO_TRACE_SPEC.md` §11

---

## 7. 已有实现参考

| Agent | TraceInput 类 | 主数据源 | 补充数据源 | Join Key |
|-------|--------------|---------|-----------|----------|
| qoder/qoder-cli | `QoderTraceInput` | hook JSONL | session segments (CLI) + SQLite (IDE) | response_id / timestamp |

### 关键文件

```
src/inputs/qoder-trace/
  ├── qoder-trace-input.ts          # 主类（collect → group → enrich → trace_id）
  ├── segment-token-reader.ts       # 读 session segments（CLI tokens + 时间戳）
  ├── sqlite-token-reader.ts        # 读 SQLite（IDE tokens）
  └── token-enricher.ts             # 合并逻辑（match + inject + 时间戳保护）

assets/hooks/
  ├── qoder-hook-processor.mjs      # progress/hook 事件解析 + 多 parts 合并 + 后台重试
  └── shared/hook-processor-base.mjs # 共享基础设施（offset 追踪、logging、history 写入）

参考其他 Agent 的 hook processor 实现:
  ├── claude-code-hook-processor.mjs # alignWithHookEvents 模式（hook 事件校准时间）
  └── codex-hook-processor.mjs      # react-step-builder 模式（tool start/end 推导时间）
```

---

## 8. 踩坑记录

以下是实际开发中遇到的问题，供后续参考：

1. **auto-updater 覆盖本地部署**：pilot 的 updater 会自动下载远程版本并切换 `current` 指针。本地开发时需在 config 中设 `autoUpdate.enabled=false`。

2. **`resolveHome()` 在模块顶层调用导致 mock 失败**：ESM 模块的顶层表达式在 vi.mock 生效前执行。解决：改为函数（延迟求值）。

3. **esbuild bundle 中 `require()` 不工作**：ESM bundle 中的 `require('node:fs')` 可能被 esbuild 处理异常。解决：使用 `import` 语法。

4. **hook 内 sleep 等待 transcript 形成死锁**：Agent 在 hook 返回后才继续写入 transcript。hook 等待越久，transcript 写入越晚。解决：后台 spawn 子进程延迟重试。

5. **progress 事件重复**：每个 hookEvent 为每个注册的 command 写一条 progress。需要去重（取首条）。

6. **thinking+text 时间戳差 1ms**：IDE 变体的同一 LLM 调用的 thinking 和 text 时间戳可能相差微秒级。用严格相等判断会误分到不同 step。解决：用 progress 事件作为边界（最可靠），或时间戳接近度阈值（>100ms 才算新 step）。

7. **SQLite `requestId` = turn 而非 LLM 调用**：IDE SQLite 的 `request_id` 对应一次 "turn"（可包含多次 LLM 调用），不是一次 LLM 调用。Token 注入时需按 `gmtCreate` 去重，每次 LLM 调用独立写 token。

8. **多数据源时钟不一致导致 STEP 时间重叠**：transcript 中 `tool_result` 的时间戳（由 hook 执行延迟影响）与 session segment 中 `model.request.started` 的时间戳来自不同时钟源，两者可能相差数秒。如果 LLM 时间用 segment、TOOL 时间用 transcript，会导致下一个 STEP 的 start 早于上一个 STEP 的 end（重叠）。解决：对于有 session segments 的变体（如 CLI），**统一使用 segment 时钟**覆盖所有 span 时间戳（`model.request.started` → llm.request, `model.response.completed` → llm.response, `tool.execution.finished` → tool.result）。不要混用不同时钟源。

9. **`loadHookRuntimeConfig` 的 dataDir 路径计算**：从 `shared/` 子目录中的 `HOOKS_DIR` 推导 dataDir 时，`path.join(HOOKS_DIR, '..')` 已经是正确路径，不要再套一层 `path.dirname()`。多一层会导致路径指向 home 目录而非 `~/.loongsuite-pilot`，使 config.json 加载失败、内容策略不生效。
