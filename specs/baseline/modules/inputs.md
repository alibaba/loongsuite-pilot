# Module: inputs

> Last verified: 2026-05-13

## 职责 (Responsibility)

数据采集层，通过多种策略从 AI coding agents 的本地存储中增量提取活动数据并发射标准化 entries。

## 公共接口 (Public Interface)

### BaseInput (`base/base-input.ts`)
```ts
abstract class BaseInput extends EventEmitter {
  abstract readonly id: string
  abstract readonly agentType: ClientType
  abstract readonly collectionMethod: CollectionMethod
  get running(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  // Events: 'entries' → AgentActivityEntry[]
}
```

### BaseIdeInput (`base/base-ide-input.ts`)
```ts
abstract class BaseIdeInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling
  protected abstract scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]>
  protected abstract buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null>
}
```

### BaseSqliteInput (`base/base-sqlite-input.ts`)
```ts
abstract class BaseSqliteInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SqlitePolling
  protected abstract readNewRows(lastRowId: number): Promise<SqliteRow[]>
  protected abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>
}
```

### BaseHookInput (`base/base-hook-input.ts`)
```ts
abstract class BaseHookInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.HookJsonl
  protected abstract transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null>
}
```

### BaseSessionInput (`base/base-session-input.ts`)
```ts
abstract class BaseSessionInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.SessionFilePolling
  protected abstract discoverSessionFiles(): Promise<string[]>
  protected abstract processSessionLine(record, filePath): Promise<AgentActivityEntry | null>
}
```

### BaseCliForwarder (`base/base-cli-forwarder.ts`)
```ts
abstract class BaseCliForwarder extends BaseInput {
  readonly collectionMethod = CollectionMethod.CliTelemetryForwarding
  protected abstract isRelevantEvent(event: Record<string, unknown>): boolean
  protected abstract transformPayload(event: Record<string, unknown>): Promise<AgentActivityEntry | null>
}
```

## 内部设计 (Internal Design)

### 生命周期 (Lifecycle)

```
init (constructor) → start() → [onStart() → runCycle() → setInterval] → stop() → [clearInterval → onStop()]
```

每个 cycle：调用 `collect()` → 非空时 emit `'entries'` → `stateStore.save()`

### 类继承树
```
BaseInput
 ├── BaseIdeInput       → IDE 本地文件快照轮询（使用 SnapshotStore dedup）
 ├── BaseSqliteInput    → SQLite rowid 游标增量查询
 ├── BaseHookInput      → Hook JSONL 日志字节偏移增量读取
 ├── BaseSessionInput   → Session 文件轮询（inode-aware rotation 检测）
 └── BaseCliForwarder   → CLI 遥测日志转发 + 过滤 + 归档
```

### 游标/去重策略

| Base Class | 策略 |
|-----------|-----|
| BaseIdeInput | SnapshotStore (key = filePath@@timestamp@@agentType) + highWatermark |
| BaseSqliteInput | 持久化 lastRowId 游标 |
| BaseHookInput | 每日文件的字节偏移 (lastFile + lastOffset) |
| BaseSessionInput | 每文件字节偏移 + inode rotation 检测 |
| BaseCliForwarder | 原始遥测文件的字节偏移 |

### 静态方法约定
每个具体 Input 类通常导出：
- `static getWatchPaths(): string[]` — 用于 AgentDiscoveryService fs.watch
- `static checkAvailability(): Promise<boolean>` — 检测 agent 数据目录是否存在

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AgentActivityEntry`, `ClientType`, `CollectionMethod`, `InputState`, `CodeGenerationEvent` |
| checkpoints | `StateStore`, `SnapshotStore` |
| normalization | `buildAgentActivityEntry` |
| utils | `createLogger`, `resolveHome`, `ensureDir`, `getTodayDateString`, `appendLine` |

## 扩展指南 (Extension Guide)

### 添加新 Agent Input

1. **选择合适的 Base Class**：
   - Agent 有 SQLite 数据库 → 继承 `BaseSqliteInput`
   - Agent 通过 Hook 脚本输出 JSONL → 继承 `BaseHookInput`
   - Agent 有 session/transcript 文件 → 继承 `BaseSessionInput`
   - Agent 有 IDE 本地历史快照 → 继承 `BaseIdeInput`
   - Agent 的 CLI 写入遥测日志需要转发 → 继承 `BaseCliForwarder`

2. **创建实现文件** `src/inputs/<agent-name>/<agent-name>-input.ts`：
   ```ts
   export class MyAgentInput extends BaseHookInput {
     readonly id = 'my-agent';
     readonly agentType = ClientType.MyAgent;
     // 实现 abstract 方法
   }
   ```

3. **导出静态方法** `getWatchPaths()` 和 `checkAvailability()`。

4. **在 `ClientType` enum 中注册** 新 agent type。

5. **在 `Orchestrator.registerAllInputs()` 中注册**，构建 detection entry。

6. **如需安装 Hook** — 在 `HookManager` 中添加 `buildXxxHooks()` 静态方法。

## 约束 (Constraints)

1. **collect() 必须幂等且容错**：单次 cycle 失败不应丢失游标状态（catch 后 log warning 继续）。
2. **所有 entries 必须经过 entry-builder 标准化**：禁止直接构造 `AgentActivityEntry`。
3. **State key 唯一性**：每个 Input 的 `id` 全局唯一，用作 StateStore key。
4. **不允许跨 cycle 积累 entries**：每次 cycle 完毕后立即 emit，不做 buffering。
5. **onStart/onStop 是可选生命周期钩子**：不可在其中抛出中断性异常。
6. **pollIntervalMs 不得低于 5000ms**：避免过度资源消耗。
