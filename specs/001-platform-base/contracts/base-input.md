# Contract: BaseInput 抽象接口

**Module**: `src/inputs/base/base-input.ts`

## 类接口

```typescript
abstract class BaseInput extends EventEmitter {
  abstract readonly id: string;
  abstract readonly agentType: ClientType;
  abstract readonly collectionMethod: CollectionMethod;

  readonly running: boolean;

  constructor(opts: InputOptions);

  start(): Promise<void>;
  stop(): Promise<void>;

  protected abstract collect(): Promise<AgentActivityEntry[]>;
  protected onStart(): Promise<void>;   // hook, default no-op
  protected onStop(): Promise<void>;    // hook, default no-op
  protected getState(): InputState;
  protected setState(state: InputState): void;
}

interface InputOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;  // default: 60_000
}
```

## 事件契约

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `'entries'` | `AgentActivityEntry[]` | 每次 `collect()` 返回非空数组后 |

## 生命周期契约

1. `start()` → `onStart()` → 首次 `runCycle()` → 启动定时轮询 → `running = true`
2. 每个轮询周期: `collect()` → 若有数据 emit `'entries'` → `stateStore.save()`
3. `stop()` → 停止定时器 → `onStop()` → `running = false`

## 子类实现契约

### BaseIdeInput

```typescript
abstract scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]>;
abstract buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null>;
```

### BaseHookInput

```typescript
abstract transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null>;
```

### BaseSessionInput

```typescript
abstract discoverSessionFiles(): Promise<string[]>;
abstract processSessionLine(record: Record<string, unknown>, filePath: string): Promise<AgentActivityEntry | null>;
```

### BaseSqliteInput

```typescript
abstract readNewRows(lastRowId: number): SqliteRow[];
abstract transformRow(row: SqliteRow): Promise<AgentActivityEntry | null>;
```

### BaseCliForwarder

```typescript
abstract isRelevantEvent(event: Record<string, unknown>): boolean;
abstract transformPayload(payload: Record<string, unknown>): Promise<AgentActivityEntry | null>;
```

## 静态方法契约 (具体输入源)

每个具体输入源必须提供：

```typescript
static checkAvailability(): Promise<boolean>;
static getWatchPaths(): string[];
```
