## Why

当前 Wukong Input 的数据采集存在严重的字段缺失和链路断裂问题：

- **`gen_ai.step.id`**：全部四类事件（llm.request/response, tool.call/result）完全缺失，导致无法构建 STEP span，trace 链路无法还原 ReAct 循环结构
- **`gen_ai.response.finish_reasons`**：llm.response 事件 100% 缺失，无法判断 LLM 是正常结束还是触发工具调用
- **`gen_ai.usage.input_tokens` / `output_tokens`**：部分 llm.response 缺失 token 信息，由 polling 竞态条件导致
- **`gen_ai.tool.call.arguments`**：tool.call 事件完全缺失工具参数
- **`gen_ai.tool.name`（tool.result）**：tool.result 事件上 tool.name 可能缺失

根因分析显示，wukong-cli 的 AGUI 事件流中**已经包含**了所有必要的原始数据（`STEP_STARTED/FINISHED`、`TOOL_CALL_ARGS`、`RUN_ERROR`），但当前代码只处理了 7 种事件类型中的部分，遗漏了关键事件。此外，polling 时序问题导致不完整消息被永久标记为已处理。

修复后，Wukong 数据将同时满足 field-coverage 和 validate-trace 两个 skill 的质量要求。

## What Changes

- **增加 AGUI 事件处理**：新增对 `STEP_STARTED`/`STEP_FINISHED`、`TOOL_CALL_ARGS`、`TOOL_CALL_RESULT`、`RUN_ERROR` 事件的处理
- **生成 `gen_ai.step.id`**：基于 `STEP_STARTED.messageId` 跟踪 step 边界，为所有事件分配 `${turnId}:s<N>` 格式的 step.id
- **推断 `gen_ai.response.finish_reasons`**：根据 step 内是否有 tool call / RUN_ERROR / 是否为最后一个 step 推断 finish_reason
- **修复 token 竞态**：只处理已完成的消息（包含 `RUN_FINISHED` 或 `RUN_ERROR` 事件），避免处理 streaming 中的不完整消息
- **采集 `ACTIVITY_SNAPSHOT` 内建工具**：将悟空原生工具（TERMINAL, FILE_WRITE, GREP_SEARCH 等）作为 tool.call/tool.result 事件输出
- **生成 trace/span ID**：为完整链路输出生成 `trace_id`、`span_id`、`parent_span_id`

## Affected Baseline Modules

- `docs/modules/inputs.md` — Wukong Input 属于 Input Source 层，本次变更修改其内部实现
- `docs/modules/normalization.md` — 数据格式需符合 `AgentActivityEntry` schema
- `docs/modules/types.md` — 使用已有 event schema 字段，不新增字段定义
- `docs/ai_event_schema.md` — 输出数据需符合 schema 中定义的 step.id、finish_reasons 等字段语义

## Capabilities

### Enhanced Capabilities
- `wukong-input`：完善 AGUI 事件解析 — 新增 step 边界跟踪、工具参数采集、finish_reason 推断、token 竞态修复、内建工具采集、完整 trace 链路 ID 生成
