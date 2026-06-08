# Module: types

> Last verified: 2026-06-04

## 职责 (Responsibility)

全局类型定义层，提供系统级 TypeScript 接口、枚举和类型别名，是所有模块的类型契约基础。

## 公共接口 (Public Interface)

- **ClientType** — Agent 类型枚举，定义系统支持的所有 AI coding agent 标识，按 IDE、CLI、Hook 三类分组。
- **ToolType** — 工具类型枚举（IDE/CLI/Hook/Plugin），用于 agent 的高层分类。
- **CollectionMethod** — 采集方法枚举，定义各种数据采集策略（快照轮询、SQLite、Hook JSONL、Session、CLI 转发、HTTP API）。
- **AgentActivityEntry** — 核心事件类型，统一的 agent 活动条目结构，采用 dotted-key 命名直接映射 SLS 宽表列名，含必填最小字段集和可扩展的 index signature。
- **ActionType / AgentEventName** — 事件动作类型和事件名称类型定义。
- **CodeGenerationEvent / SessionRecord / ToolCallRecord / MessageRecord / TokenUsage** — 各种原始输入事件的结构化接口，用于 Input 模块解析原始数据。
- **AnalyticsConfig / AutoUpdateConfig / FlusherConfig / MaskConfig** — 系统级配置接口，定义整体服务配置、自动更新配置和输出配置的结构。
- **AgentDetectionEntry / InputState / EntryState / AgentControlMode** — 运行时状态类型，用于 agent 发现、输入状态追踪和准入控制。
- **LogRetentionConfig** — 日志保留配置接口，定义各类日志的保留天数。
- **SerializedLogEntry / JsonValue** — 序列化相关类型，用于 flusher 输出层的数据格式约定。

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/types/
├── index.ts          # 类型聚合导出，其他模块优先从这里导入
├── client-type.ts    # ClientType / ToolType / CollectionMethod 枚举
├── events.ts         # AgentActivityEntry 与原始事件结构
├── alicloud-log.d.ts # @alicloud/log 类型补充
└── pino-roll.d.ts    # pino-roll 类型补充
```

`types/index.ts` 是模块边界入口；新增共享类型时优先放在具体语义文件中，再从 `index.ts` re-export。

### AgentActivityEntry 设计哲学
- **Index signature** `[key: string]: JsonValue | undefined` 允许动态扩展字段（如 `agent.*` 属性展开）
- **Dotted key 命名** 直接映射 SLS wide-table 列名，避免序列化时额外投影
- **必填字段最小集**：`time_unix_nano`, `event.id`, `user.id`, `event.name`, `gen_ai.session.id`, `gen_ai.agent.type`, `gen_ai.provider.name`

### ClientType 分类体系
按采集通道分为三组：
- **IDE tools**：通过 IDE 本地存储采集（snapshot polling / SQLite）
- **CLI tools**：通过 session files 或转发机制采集
- **Hook-based tools**：通过注入 Hook 脚本写入 JSONL 采集

### CollectionMethod 与 Base Class 映射
| CollectionMethod | 对应 Base Class |
|-----------------|----------------|
| IdeSnapshotPolling | BaseIdeInput |
| SqlitePolling | BaseSqliteInput |
| HookJsonl | BaseHookInput |
| SessionFilePolling | BaseSessionInput |
| CliTelemetryForwarding | BaseCliForwarder |
| LsHttpApi | (预留，暂无实现) |

## 依赖关系 (Dependencies)

本模块为纯类型定义，无运行时依赖。`index.ts` re-exports `client-type.ts` 和 `events.ts`。

## 约束 (Constraints)

1. **AgentActivityEntry 必填字段不可设为 optional**：所有 Input 必须保证这些字段有值。
2. **ClientType enum 值为 kebab-case 字符串**：与 SLS logstore 字段值保持一致。
3. **新增 agent 必须注册 ClientType**：不允许使用裸字符串作为 agent type。
4. **JsonValue 递归类型严格**：不接受 `undefined`、`Date`、`RegExp` 等非 JSON-safe 值。
5. **SlsEndpoint.kind 枚举固定**：仅 `'agentActivity' | 'agentTelemetry' | 'mcp' | 'trace'`。
6. **SlsEndpoint 自包含**：每个 endpoint 携带完整的 URL、mode、凭据，独立于同一 flusher 中的其他 endpoint。
7. **EntryState 状态机顺序性**：必须遵循 idle→starting→running→stopping→idle 转换。
8. **MaskType 必须与规则文件同步**：新增 mask 类型时必须同时更新 `MaskType`、配置解析、`src/mask/sensitive-rules.json` 和测试。
