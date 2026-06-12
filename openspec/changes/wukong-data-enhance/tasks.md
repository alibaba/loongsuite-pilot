## 1. Token 竞态修复 — 只处理已完成消息

- [x] 1.1 在 `doCollect()` 中新增 `isMessageComplete()` 判断函数：检查 assistant message 的 events 数组是否包含 `RUN_FINISHED` 或 `RUN_ERROR`
- [x] 1.2 修改 message slicing 逻辑：只有已完成的消息才计入 seenCounts 推进，未完成消息留待下次 poll
- [x] 1.3 补充单元测试：验证 streaming 中的不完整消息不会被处理、下次 poll 时完整消息能被正确采集

## 2. Step 边界跟踪与 step.id 生成

- [x] 2.1 新增 `StepContext` 接口和 step 跟踪状态（stepIndex, currentStepId, stepMessageId, hasToolCalls）
- [x] 2.2 在事件循环中处理 `STEP_STARTED`：创建新 StepContext，stepIndex 递增，生成 `${turnId}:s${stepIndex}` 格式的 step.id
- [x] 2.3 处理 `STEP_FINISHED`：关闭当前 step context
- [x] 2.4 Fallback 逻辑：若整个消息无 `STEP_STARTED` 事件，视为单个 step（step.id = `${turnId}:s1`）
- [x] 2.5 将 `gen_ai.step.id` 设置到所有事件输出（llm.request, llm.response, tool.call, tool.result）
- [x] 2.6 补充单元测试：多 step 消息、单 step 消息、fallback 场景

## 3. finish_reasons 推断

- [x] 3.1 处理 `RUN_ERROR` 事件：捕获 `code` 和 `message` 字段
- [x] 3.2 实现 finish_reasons 推断逻辑：有 tool call → `["tool_calls"]`; RUN_ERROR → `["stop"]` + error fields; 最后一个 step 无 tool → `["end_turn"]`; 其他 → `["stop"]`
- [x] 3.3 在 llm.response 输出中设置 `gen_ai.response.finish_reasons`
- [x] 3.4 当 RUN_ERROR 存在时，设置 `error.type` 和 `error.message`
- [x] 3.5 补充单元测试：各种 finish_reason 场景（纯文本回答、触发工具、错误中断）

## 4. TOOL_CALL_ARGS 采集

- [x] 4.1 新增 `toolArgsAccumulator: Map<string, string>` 数据结构
- [x] 4.2 处理 `TOOL_CALL_ARGS` 事件：按 toolCallId 累积 delta 字符串
- [x] 4.3 在 emit tool.call 时从 accumulator 读取完整 arguments 并设置 `gen_ai.tool.call.arguments`
- [x] 4.4 处理 `TOOL_CALL_RESULT` 事件：使用 content 作为 `gen_ai.tool.call.result`，使用 is_error 标志
- [x] 4.5 补充单元测试：多 delta 累积、单次 delta、缺少 TOOL_CALL_ARGS 的 fallback

## 5. ACTIVITY_SNAPSHOT 内建工具采集

- [x] 5.1 实现 `transformActivitySnapshot()` 函数：将 ACTIVITY_SNAPSHOT 事件转换为 tool.call + tool.result 对
- [x] 5.2 映射 activityType 到 tool.name（TERMINAL → terminal, FILE_WRITE → file_write 等）
- [x] 5.3 从 ACTIVITY_SNAPSHOT.content 提取 arguments 和 result 字段
- [x] 5.4 计算 duration（content.finish_time - content.start_time）
- [x] 5.5 为 ACTIVITY_SNAPSHOT 工具继承当前 step 的 step.id
- [x] 5.6 补充单元测试：各种 activityType 转换

## 6. Trace/Span ID 生成

- [x] 6.1 为每个 turn（assistant message）生成 `trace_id`（32 hex chars）
- [x] 6.2 生成分层 span_id：entry/agent/step/llm/tool 各一个
- [x] 6.3 设置 `parent_span_id`：llm/tool events → parent = stepSpanId
- [x] 6.4 将 trace_id、span_id、parent_span_id 设置到所有输出事件
- [x] 6.5 补充单元测试：验证 span tree 层级关系正确

## 7. 重构 transformMessages 主循环

- [x] 7.1 将现有 switch-case 重构为新的事件处理流程，整合 step tracking、args accumulation、activity snapshot 处理
- [x] 7.2 确保事件输出顺序正确：同一 step 内先 llm.request，再 llm.response，再 tool.call/result
- [x] 7.3 向后兼容：无 STEP_STARTED 事件时回退为原有逻辑
- [x] 7.4 现有单元测试全部通过（不破坏已有行为）

## 8. 验证与质量保障

- [x] 8.1 运行完整单元测试套件，确保所有测试通过
- [x] 8.2 Verify implementation conforms to baseline constraints（数据格式符合 ai_event_schema.md）
- [ ] 8.3 可选：本地 E2E 测试 — 启动 pilot + wukong-cli 验证真实数据采集（user-initiated, see specs/local-e2e-testing-guide.md）
