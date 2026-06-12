# Module: normalization

> Last verified: 2026-06-04

## 职责 (Responsibility)

数据标准化层，负责将各种原始输入格式转换为统一的 AgentActivityEntry，并根据内容策略决定内容字段是否保留。字段内 secret 打码由独立的 mask 模块负责。

Hook JSONL 输入在进入 collector 前可能已经由 `assets/hooks/agent-event-normalizer.mjs` 做过 pre-standardization。该 hook-side 逻辑可以 best-effort 复制 `user.id` defaulting、provider fallback 和 content-policy filtering；本模块仍是最终权威层，负责 final `AgentActivityEntry` 构建、alias cleanup、provider fallback re-apply、content policy re-apply 和序列化前 schema 语义收敛。

## 公共接口 (Public Interface)

- **buildAgentActivityEntry** — Entry 构建器，将原始输入参数（支持 Legacy 和 Standard 两种模式）转换为统一的 AgentActivityEntry。
- **buildFromCodeGenerationEvent** — 专用构建器，将 IDE 代码生成事件转换为标准 AgentActivityEntry。
- **serialiseLogEntry** — 序列化器，将 entry 转为扁平的 Record<string, string> KV 格式，用于 flusher 发送。
- **redactCodeGenerationFields** — 脱敏器，删除序列化结果中可能含代码内容的字段集合。
- **applyAgentContentPolicy** — 内容策略执行器，根据 per-agent 配置决定是否保留消息内容字段。
- **辅助工具函数** — 提供时间戳转换、事件名标准化、provider 推断、finish reason 解析等通用能力。

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/normalization/
├── entry-builder.ts          # AgentActivityEntry 构建、alias 清理、序列化、字段脱敏
└── agent-content-policy.ts   # per-agent message content policy
```

`entry-builder.ts` 是 collector 侧 schema 映射的主入口；新增稳定字段、legacy alias、provider/model 推断或序列化规则时优先在这里集中处理。若 hook runtime 需要复制部分规则，必须保持 dependency-free，并在 collector 侧继续执行最终权威规则。

### Entry Builder 双模式构建

1. **Legacy 模式**：接收 `LegacyAgentActivityOptions`（含 `sessionId`, `agentType`, `actionType` 等旧字段），内部转换为标准格式后递归调用标准构建流程。
2. **Standard 模式**：接收 `StandardAgentActivityOptions`（使用 dotted-key 风格如 `'session.id'`, `'agent.type'`），支持 canonical 和 legacy alias 双重映射。

### 字段别名系统

使用 `stringAlias(input, canonical, legacy)` 模式，canonical key 优先，legacy key 作为 fallback。构建完成后通过 `removeLegacyAliases()` 清除所有短名称字段。

### Provider 推断

`inferProviderName()` 按以下优先级推断 provider：

1. 显式设置的 `provider.name`
2. 从 model 名称正则匹配（claude→anthropic, gpt→openai, qwen→qwen 等）
3. 从 agent type 推断

### Serialization

`serialiseLogEntry()` 将 entry 转为 `Record<string, string>` 扁平格式：

- 跳过 `undefined`/`null` 值
- 跳过所有 legacy alias 字段
- object/array → `JSON.stringify`
- 其余 → `String()`

### Redaction

`redactCodeGenerationFields()` 删除可能含代码内容的字段集合（`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments` 等），用于对指定 SLS endpoint 进行脱敏。

### Agent Content Policy

`applyAgentContentPolicy()` 根据 per-agent config 中 `captureMessageContent` 设置。即使 hook processor 已执行 best-effort policy filtering，collector 侧仍必须再次执行该策略：

- `true`（默认）→ 原样透传
- `false` → 删除 MESSAGE_CONTENT_FIELDS 集合中的所有消息内容字段

按 agent type 查找策略：`entry['gen_ai.agent.type']` → `config[agentType]` → 默认允许。

字段内 secret 打码不在 normalization 模块内实现。collector 链路在 `applyAgentContentPolicy()` 之后调用 `maskAgentActivityEntry()`，因此 `captureMessageContent=false` 删除的字段不会再进入 mask 扫描。



目前上面的配置放在 InputManager里面，但这是代码不合理的设置，后面会进行统一迁移处理。

## 依赖关系 (Dependencies)


| 依赖模块  | 导入内容                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| types | `AgentActivityEntry`, `AgentEventName`, `CodeGenerationEvent`, `JsonValue`, `SerializedLogEntry`, `ClientType`, `ActionType`, `AgentsConfig`, `AgentConfig` |
| 外部库   | `uuid` (v4)                                                                                                                                                 |


## 约束 (Constraints)

1. **entry 必须包含 `time_unix_nano` 和 `event.id`**：构建时自动补全（当前时间 / UUIDv4）。
2. **Legacy alias 字段不得出现在最终 entry 中**：`removeLegacyAliases()` 必须在返回前执行。
3. `**serialiseLogEntry` 的输出为纯 string value map**：不得含 number/boolean/object 值。
4. **Redaction 是不可逆操作**：在 serialized 副本上操作，不修改原始 entry。
5. `**applyAgentContentPolicy` 返回新对象**：不修改输入 entry（immutable semantics）。
6. **时间戳格式为 nanoseconds string**：`time_unix_nano` 长度≥16位，毫秒输入自动补零。
7. **Hook-side pre-standardization 不是最终权威层**：collector normalization 必须保留最终构建、provider fallback、content policy 和 alias cleanup。
