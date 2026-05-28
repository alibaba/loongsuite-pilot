## Why

Cursor 的 `stop` hook 事件和 `afterAgentResponse` hook 事件携带完全相同的 token 使用数据（`input_tokens`、`output_tokens`、`cache_read_tokens`、`total_tokens` 等）。当下游对这些事件做 token 统计时，同一个 turn 的 token 会被重复计入两次，导致用量数据膨胀一倍。

验证数据来源：
- 测试 fixture（`tests/fixtures/cursor-hook/raw-cursor-hooks-2026-04-30.jsonl`）中两个完整 turn 的 `afterAgentResponse` 和 `stop` token 完全一致。
- lukechen 机器上的真实采集数据（session `a4888587`，turn `fccbb9a9`）两者完全一致。
- 本地 Cursor 实际对话数据（turn `67415aba`，input_tokens=152702，output_tokens=2272）两者完全一致。

`afterAgentResponse` 是语义更准确的事件（映射为 `llm.response`），携带 LLM 输出内容；`stop` 是生命周期事件（映射为 `other`），携带 status 和 loop_count 等会话结束信息。Token 应归属于 LLM response 事件，不应在生命周期事件中重复出现。

## What Changes

- 在 Cursor hook processor（`assets/hooks/agent-event-normalizer.mjs`）的 `buildCursorHookRecord` 函数中，当 source hook event 为 `stop` 时，不映射 token/cost 相关字段到输出记录。
- `stop` 事件的其他字段（status、loop_count、transcript_path 等生命周期信息）保持不变。
- 在 `CursorHookInput`（`src/inputs/cursor-hook/cursor-hook-input.ts`）的 `transformRecord` 中增加同样的保护，确保从 canonical 和 legacy 两条路径都不会对 `stop` 事件输出 token 字段。

## Capabilities

### New Capabilities
- 无。

### Modified Capabilities
- 无。这是数据正确性修复，不涉及新的或已有的 capability spec。

## Impact

- Affected baseline modules: `hooks`（asset hook normalizer 逻辑变更）, `inputs`（CursorHookInput transform 保护）。
- Affected code areas:
  - `assets/hooks/agent-event-normalizer.mjs` — `buildCursorHookRecord` 函数
  - `src/inputs/cursor-hook/cursor-hook-input.ts` — `transformRecord` 方法
  - 相关单元测试
- 下游影响：token 统计值将减少约 50%（消除了重复计数），这是正确的行为。
- 不引入新的外部依赖。

## Baseline Documentation Updates

- 无需修改基准文档。本变更不改变架构、数据流或模块职责，仅修正 hook processor 对 `stop` 事件的字段映射策略。
