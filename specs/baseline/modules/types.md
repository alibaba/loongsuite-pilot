# Module: types

> Last verified: 2026-05-13

## 职责 (Responsibility)

全局类型定义层，提供系统级 TypeScript 接口、枚举和类型别名，是所有模块的类型契约基础。

## 公共接口 (Public Interface)

### client-type.ts — 枚举定义
```ts
enum ClientType {
  // IDE tools
  Cursor, Qoder, QoderIdea, QoderWork, Kiro, KiroCli,
  Antigravity, Lingma, LingmaVscode,
  // CLI tools
  GeminiCli, YkCli, QwenCodeCli, KimiCodeCli, CodexSession, QoderCli,
  // Hook-based tools
  ClaudeCliHook, IflowCliHook, CursorHook, QoderCliHook,
  CodexCliHook, ClineHook, GithubCopilotHook, AoneCopilotHook, OpencodePlugin,
}

enum ToolType { IDE, CLI, Hook, Plugin }

enum CollectionMethod {
  IdeSnapshotPolling, SqlitePolling, HookJsonl,
  CliTelemetryForwarding, SessionFilePolling, LsHttpApi,
}
```

### events.ts — 核心事件类型
```ts
enum ActionType { Create, Edit, Delete, Read, Search, Execute, Browse, Other }

type AgentEventName = 'llm.request' | 'llm.response' | 'tool.call'
  | 'tool.result' | 'skill.use' | 'tool.approve' | 'other'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface AgentActivityEntry {
  [key: string]: JsonValue | undefined
  time_unix_nano: string
  'event.id': string
  'user.id': string
  'event.name': AgentEventName
  'gen_ai.session.id': string
  'gen_ai.agent.type': string
  'gen_ai.provider.name': string
  // ... 40+ optional gen_ai.* fields (usage, cost, tool, messages)
}

interface CodeGenerationEvent { agentType, filePath, actionType, content?, diff?, sourceTimestamp, rawData }
interface SessionRecord { sessionId, agentType, model?, usage?, startedAt, endedAt? }
interface ToolCallRecord { toolName, parameters?, result?, status, durationMs? }
interface MessageRecord { role, content, items? }
interface TokenUsage { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
type SerializedLogEntry = Record<string, string>
interface GitHookEvent { eventType, repoRoot, commitHash, branchName, changedFiles, timestamp }
```

### index.ts — 配置与运行时类型（re-exports + 补充定义）
```ts
interface AnalyticsConfig { enabled, autoStart, dataDir, userId, listeners, flushers, retention, agents }
interface AutoUpdateConfig { enabled, checkIntervalMs, manifestUrl?, packageUrl? }
interface FlusherConfig { sls?, jsonl?, http? }
interface SlsFlusherConfig { enabled, mode, accessKeyId, accessKeySecret, endpoint, endpoints, batchMaxSize, flushIntervalMs }
interface SlsEndpoint { name, project, logstore, kind, redact? }
interface JsonlFlusherConfig { enabled, outputDir, rotateDaily, maxFileSizeMb }
interface HttpFlusherConfig { enabled, url, headers?, batchMaxSize, flushIntervalMs, requestTimeoutMs }
interface AgentDetectionEntry { id, type, isAvailable, watchPaths, enabled, start, stop, pollIntervalMs }
interface LogRetentionConfig { enabled, intervalMs, hookHistoryDays, hookErrorDays, hookDebugDays, outputDays, slsFailedDays }
interface InputState { lastOffset?, lastFile?, lastRowId?, lastTimestamp?, highWatermark?, extra? }
type AgentControlMode = 'on' | 'off' | 'auto'
interface AgentControlConfig { version, tools: Record<string, AgentControlMode> }
type EntryState = 'idle' | 'starting' | 'running' | 'stopping'
type AgentsConfig = Record<string, AgentConfig>
interface AgentConfig { captureMessageContent: boolean }
type SlsMode = 'ak' | 'webtracking'
```

## 内部设计 (Internal Design)

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
6. **EntryState 状态机顺序性**：必须遵循 idle→starting→running→stopping→idle 转换。
