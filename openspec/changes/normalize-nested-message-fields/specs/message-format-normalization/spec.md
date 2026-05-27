## ADDED Requirements

### Requirement: 规范化 output messages 为标准格式
规范化层必须将 `gen_ai.output.messages` 的值转换为标准格式 `[{role: "assistant", parts: [...], finish_reason?: string}]`。转换必须是幂等的——已符合标准的数据经过处理后不变。

#### Scenario: 裸 parts 数组缺少 role 包装
- **WHEN** `gen_ai.output.messages` 为 `[{type: "text", content: "hello"}]`（无 `role` 和 `parts`）
- **THEN** 必须转换为 `[{role: "assistant", parts: [{type: "text", content: "hello"}]}]`

#### Scenario: 裸 reasoning part
- **WHEN** `gen_ai.output.messages` 为 `[{type: "reasoning", content: "thinking..."}]`
- **THEN** 必须转换为 `[{role: "assistant", parts: [{type: "reasoning", content: "thinking..."}]}]`

#### Scenario: camelCase finishReason 转为 snake_case
- **WHEN** `gen_ai.output.messages` 为 `[{role: "assistant", parts: [...], finishReason: "stop"}]`（camelCase）
- **THEN** 必须将 `finishReason` 重命名为 `finish_reason`，输出 `[{role: "assistant", parts: [...], finish_reason: "stop"}]`

#### Scenario: 已符合标准格式
- **WHEN** `gen_ai.output.messages` 为 `[{role: "assistant", parts: [{type: "text", content: "hello"}], finish_reason: "stop"}]`
- **THEN** 直接返回，不做修改

#### Scenario: 多个 parts 合并为一条消息
- **WHEN** `gen_ai.output.messages` 为 `[{type: "reasoning", content: "think"}, {type: "text", content: "answer"}]`（多个裸 parts）
- **THEN** 所有 parts 必须包装为单条消息：`[{role: "assistant", parts: [{type: "reasoning", content: "think"}, {type: "text", content: "answer"}]}]`

#### Scenario: undefined 或 null 输入
- **WHEN** `gen_ai.output.messages` 为 `undefined` 或 `null`
- **THEN** 返回 `undefined`

### Requirement: 规范化 input messages delta 为标准格式
规范化层必须将 `gen_ai.input.messages_delta` 的值转换为标准格式 `[{role, parts: [{type: "text", content}]}]`。转换必须是幂等的。

#### Scenario: 扁平 content 字符串
- **WHEN** `gen_ai.input.messages_delta` 为 `[{role: "user", content: "hello"}]`（扁平字符串 content，无 `parts`）
- **THEN** 必须转换为 `[{role: "user", parts: [{type: "text", content: "hello"}]}]`

#### Scenario: 已符合标准的 parts 格式
- **WHEN** `gen_ai.input.messages_delta` 为 `[{role: "user", parts: [{type: "text", content: "hello"}]}]`
- **THEN** 直接返回，不做修改

#### Scenario: undefined 或 null 输入
- **WHEN** `gen_ai.input.messages_delta` 为 `undefined` 或 `null`
- **THEN** 返回 `undefined`

### Requirement: 规范化完整 input messages 为标准格式
规范化层必须对 `gen_ai.input.messages` 应用与 `gen_ai.input.messages_delta` 相同的 `parts` 包装转换。

#### Scenario: 完整 input messages 中的扁平 content
- **WHEN** `gen_ai.input.messages` 为 `[{role: "user", content: "hello"}]`
- **THEN** 必须转换为 `[{role: "user", parts: [{type: "text", content: "hello"}]}]`

#### Scenario: 已符合标准格式
- **WHEN** `gen_ai.input.messages` 为 `[{role: "user", parts: [{type: "text", content: "hello"}]}]`
- **THEN** 直接返回，不做修改

### Requirement: entry-builder 中心化规范化
`buildAgentActivityEntry` 必须在返回 entry 之前对 `gen_ai.output.messages`、`gen_ai.input.messages_delta` 和 `gen_ai.input.messages` 调用规范化函数。确保所有经过中心化构建器的 entry 都符合标准格式，无论来源 input 如何构造。

#### Scenario: 非标准格式经过 buildAgentActivityEntry 后被规范化
- **WHEN** 调用 `buildAgentActivityEntry` 时 `gen_ai.output.messages` 为 `[{type: "text", content: "hello"}]`
- **THEN** 返回的 entry 的 `gen_ai.output.messages` 必须为 `[{role: "assistant", parts: [{type: "text", content: "hello"}]}]`

#### Scenario: 已标准格式经过 buildAgentActivityEntry 后保持不变
- **WHEN** 调用 `buildAgentActivityEntry` 时 `gen_ai.output.messages` 已为标准格式
- **THEN** 返回的 entry 的 `gen_ai.output.messages` 保持不变

### Requirement: hook 层 cursor 源头格式修复
`agent-event-normalizer.mjs` 的 `buildCursorOutputMessages` 和 `buildCursorInputMessagesDelta` 必须在 hook 层直接生成标准格式。input 层（`CursorHookInput`）无需二次修复，保持透传。

#### Scenario: cursor hook buildCursorOutputMessages 生成标准格式
- **WHEN** hook 处理一条 `hookEvent: "agentResponse"`、`text: "hello"` 的 cursor payload
- **THEN** `gen_ai.output.messages` 必须为 `[{role: "assistant", parts: [{type: "text", content: "hello"}]}]`

#### Scenario: cursor hook buildCursorInputMessagesDelta 生成标准格式
- **WHEN** hook 处理一条 `hookEvent: "beforeSubmitPrompt"`、`prompt: "fix bug"` 的 cursor payload
- **THEN** `gen_ai.input.messages_delta` 必须为 `[{role: "user", parts: [{type: "text", content: "fix bug"}]}]`

### Requirement: hook 层 qoder 源头格式修复
`agent-event-normalizer.mjs` 的 `buildQoderOutputMessages` 和 `buildQoderInputMessagesDelta` 必须在 hook 层直接生成标准格式。input 层（`QoderCliInput`）无需二次修复，保持透传。

#### Scenario: qoder hook buildQoderOutputMessages 生成标准格式
- **WHEN** hook 处理一条 assistant 类型、包含文本内容的 qoder transcript 行
- **THEN** `gen_ai.output.messages` 必须为 `[{role: "assistant", parts: [{type, content}]}]`

#### Scenario: qoder hook buildQoderInputMessagesDelta 生成标准格式
- **WHEN** hook 处理一条 user 类型、包含用户文本的 qoder transcript 行
- **THEN** `gen_ai.input.messages_delta` 必须为 `[{role: "user", parts: [{type: "text", content}]}]`

### Requirement: qoder-work hook 格式修复
qoder-work hook 数据通过 `buildCanonicalHookEntry` 从上游 hook 脚本（`agent-event-normalizer.mjs` 的 `buildQoderHookRecord`）直通传递。hook 层已在源头生成标准格式，`buildAgentActivityEntry` 中的中心化规范化作为幂等安全网。

#### Scenario: qoder-work hook output messages 已在 hook 层规范化
- **WHEN** qoder-work hook 记录经过 `buildQoderHookRecord` 处理后，`gen_ai.output.messages` 已为 `[{role: "assistant", parts: [{type: "text", content: "hello"}]}]`
- **THEN** 经过 `buildCanonicalHookEntry` 和 `buildAgentActivityEntry` 后保持不变

#### Scenario: qoder-work hook input messages delta 已在 hook 层规范化
- **WHEN** qoder-work hook 记录经过 `buildQoderHookRecord` 处理后，`gen_ai.input.messages_delta` 已为 `[{role: "user", parts: [{type: "text", content: "hello"}]}]`
- **THEN** 经过 `buildCanonicalHookEntry` 和 `buildAgentActivityEntry` 后保持不变
