## Context

Cursor 通过 `~/.cursor/hooks.json` 注册了 12 个 hook 事件。其中 `afterAgentResponse` 和 `stop` 两个事件在同一个 turn 结束时先后触发（间隔约 200ms），携带完全相同的 token usage 数据。当前 `buildCursorHookRecord`（normalizer）和 `CursorHookInput`（collector input）均无差别地将两者的 token 字段映射到输出记录，导致同一 turn 的 token 被统计两次。

## Goals / Non-Goals

**Goals:**
- 消除 `stop` 事件与 `afterAgentResponse` 事件之间的 token 数据重复。
- 保留 `stop` 事件的生命周期字段（status、loop_count、transcript_path）。
- 在 hook processor（asset 层）和 collector input 两层都做保护，确保无论走 canonical 还是 legacy 路径都不会重复。

**Non-Goals:**
- 不修改 `afterAgentResponse` 事件的处理逻辑。
- 不修改其他 hook 事件（`sessionStart`、`sessionEnd`、`preToolUse` 等）。
- 不修改 `AgentActivityEntry` schema。
- 不修改 Qoder 相关的 hook 处理。

## Decisions

### Token 字段归属于 `afterAgentResponse`，不归属于 `stop`

`afterAgentResponse` 映射为 `llm.response`，语义上是"LLM 产出了一次回复"，token 是这次回复的度量。`stop` 映射为 `other`，语义上是"agent turn 结束了"，是生命周期事件。Token 计量应当附着在产出事件上，生命周期事件只需标记状态。

### 两层去重防护

```
Layer 1: asset hook processor (agent-event-normalizer.mjs)
    buildCursorHookRecord() 
    → 当 sourceEvent 为 stop 时，不设置 token/cost 字段
    → 写入 history JSONL 的 stop 记录不含 token

Layer 2: collector input (cursor-hook-input.ts)
    transformRecord()
    → 当 hook_event_name 为 stop 时，不映射 token/cost 字段
    → 防护旧格式 history 文件中已含 token 的 stop 记录
```

Layer 2 作为向后兼容保护：在本次变更部署之前产生的 history JSONL 中，`stop` 记录仍然含有 token 字段。collector input 层的过滤确保即使读到旧格式数据也不会重复计数。

### 需要过滤的字段清单

以下字段在 `stop` 事件中应被置为 `undefined`：

| 字段 | 说明 |
|------|------|
| `gen_ai.usage.input_tokens` | 输入 token 数 |
| `gen_ai.usage.output_tokens` | 输出 token 数 |
| `gen_ai.usage.cache_read.input_tokens` | 缓存读取 token 数 |
| `gen_ai.usage.cache_creation.input_tokens` | 缓存创建 token 数 |
| `gen_ai.usage.total_tokens` | 总 token 数 |
| `gen_ai.usage.input_cost` | 输入成本 |
| `gen_ai.usage.output_cost` | 输出成本 |
| `gen_ai.usage.cache_read.input_cost` | 缓存读取成本 |
| `gen_ai.usage.cache_creation.input_cost` | 缓存创建成本 |
| `gen_ai.usage.total_cost` | 总成本 |

### 不过滤 `sessionEnd` 的 token 字段

`sessionEnd` 事件目前不携带 token 数据（仅有 `duration`）。如果未来 Cursor 在 `sessionEnd` 中加入聚合 token，那会是跨 turn 的汇总值，语义不同于单 turn 的 `afterAgentResponse`，届时需要单独设计处理策略。本次变更不预设这种情况。

## Implementation Approach

### 1. `agent-event-normalizer.mjs` — `buildCursorHookRecord`

在构建 record 对象之前，判断 `sourceEvent` 是否为 `stop`。如果是，将 token/cost 相关字段直接设为 `undefined`，使其不出现在最终的 `sanitizeObject` 输出中。

```javascript
const isStopEvent = sourceEvent.toLowerCase() === 'stop';

const record = {
  // ... 其他字段不变 ...
  'gen_ai.usage.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'input_tokens'),
  'gen_ai.usage.output_tokens': isStopEvent ? undefined : getNumberValue(payload, 'output_tokens'),
  // ... 同理处理 cache/total/cost 字段 ...
};
```

### 2. `cursor-hook-input.ts` — `transformRecord`

在 canonical path（`buildCanonicalHookEntry`）中，canonical record 直接从 JSONL 读取字段，如果 Layer 1 已经生效则 token 字段天然缺失。

在 legacy fallback path 中，增加判断：当 `hookEvent` 为 `stop` 时，不映射 token/cost 字段。

```typescript
const isStopEvent = hookEvent.toLowerCase() === 'stop';

return buildAgentActivityEntry({
  // ... 其他字段不变 ...
  'gen_ai.usage.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'input_tokens'),
  // ... 同理 ...
});
```

## Risks

- **低风险**：下游已有的 token 统计看板会显示数值下降约 50%。这是修正后的正确值，需要知会相关看板的使用者。
- **低风险**：旧 history JSONL 中的 `stop` 记录含 token，新旧数据混合期间如果仅靠 Layer 1 则仍会重复。Layer 2 的存在消除了这个风险。
