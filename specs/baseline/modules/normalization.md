# Module: normalization

> Last verified: 2026-05-13

## 职责 (Responsibility)

数据标准化层，负责将各种原始输入格式转换为统一的 AgentActivityEntry，并根据内容策略决定敏感字段的保留或脱敏。

## 公共接口 (Public Interface)

### entry-builder.ts
```ts
function buildAgentActivityEntry(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions
): AgentActivityEntry

function buildFromCodeGenerationEvent(
  event: CodeGenerationEvent, userId: string, sessionId: string
): AgentActivityEntry

function serialiseLogEntry(entry: AgentActivityEntry): SerializedLogEntry

function redactCodeGenerationFields(serialized: SerializedLogEntry): SerializedLogEntry

function timestampToUnixNanos(ts: number | string | undefined): string
function unixNanosToMillis(value: string | number | undefined): number
function normalizeEventName(value: unknown): AgentEventName
function normalizeFinishReasons(value: unknown): string[] | undefined
function inferProviderName(input: Record<string, unknown>): string
function toJsonValue(value: unknown): JsonValue | undefined
```

### agent-content-policy.ts
```ts
function applyAgentContentPolicy(
  entry: AgentActivityEntry, config: AgentsConfig
): AgentActivityEntry
```

## 内部设计 (Internal Design)

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
`applyAgentContentPolicy()` 根据 per-agent config 中 `captureMessageContent` 设置：
- `true`（默认）→ 原样透传
- `false` → 删除 MESSAGE_CONTENT_FIELDS 集合中的所有消息内容字段

按 agent type 查找策略：`entry['gen_ai.agent.type']` → `config[agentType]` → 默认允许。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AgentActivityEntry`, `AgentEventName`, `CodeGenerationEvent`, `JsonValue`, `SerializedLogEntry`, `ClientType`, `ActionType`, `AgentsConfig`, `AgentConfig` |
| 外部库 | `uuid` (v4) |

## 约束 (Constraints)

1. **entry 必须包含 `time_unix_nano` 和 `event.id`**：构建时自动补全（当前时间 / UUIDv4）。
2. **Legacy alias 字段不得出现在最终 entry 中**：`removeLegacyAliases()` 必须在返回前执行。
3. **`serialiseLogEntry` 的输出为纯 string value map**：不得含 number/boolean/object 值。
4. **Redaction 是不可逆操作**：在 serialized 副本上操作，不修改原始 entry。
5. **`applyAgentContentPolicy` 返回新对象**：不修改输入 entry（immutable semantics）。
6. **时间戳格式为 nanoseconds string**：`time_unix_nano` 长度≥16位，毫秒输入自动补零。
