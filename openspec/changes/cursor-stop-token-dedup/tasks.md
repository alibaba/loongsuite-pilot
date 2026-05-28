## 1. Asset Hook Processor 去重

- [x] 1.1 在 `assets/hooks/agent-event-normalizer.mjs` 的 `buildCursorHookRecord` 函数中，当 `sourceEvent` 为 `stop` 时，将所有 token/cost 字段（`gen_ai.usage.input_tokens`、`output_tokens`、`cache_read.input_tokens`、`cache_creation.input_tokens`、`total_tokens`、`input_cost`、`output_cost`、`cache_read.input_cost`、`cache_creation.input_cost`、`total_cost`）设为 `undefined`。
- [x] 1.2 验证 `stop` 事件的非 token 字段（`status`、`loop_count`、`transcript_path`、session/turn ID 等）不受影响。

## 2. Collector Input 向后兼容保护

- [x] 2.1 在 `src/inputs/cursor-hook/cursor-hook-input.ts` 的 `transformRecord` legacy fallback 路径中，当 `hookEvent` 为 `stop` 时，不映射 token/cost 字段。
- [x] 2.2 确认 canonical path（`buildCanonicalHookEntry`）天然不会引入已被 Layer 1 剥离的字段（无需额外修改，只需验证）。

## 3. 测试

- [x] 3.1 在 `tests/unit/hooks/agent-event-normalizer.test.mjs` 中添加测试：`stop` 事件的 processor 输出不包含 token/cost 字段，同时保留 status 和 loop_count。
- [x] 3.2 在 `tests/unit/hooks/agent-event-normalizer.test.mjs` 中添加测试：`afterAgentResponse` 事件的 processor 输出正常包含 token/cost 字段（确认没有误伤）。
- [x] 3.3 在 `tests/unit/inputs/cursor-hook-input.test.ts` 中添加测试：含 token 的旧格式 `stop` 记录经过 `transformRecord` 后输出不包含 token 字段。
- [x] 3.4 在 `tests/unit/inputs/cursor-hook-input.test.ts` 中添加测试：`afterAgentResponse` 记录经过 `transformRecord` 后正常包含 token 字段。

## 4. 验证

- [x] 4.1 运行完整测试套件（`npm test`），确保无回归。
- [x] 4.2 验证实现符合 baseline 约束（hook processor 仍然 fail-open、append-only；collector input 仍走 Input → InputManager → Flusher 管道）。
