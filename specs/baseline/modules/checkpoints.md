# Module: checkpoints

> Last verified: 2026-05-13

## 职责 (Responsibility)

持久化状态管理层，为 Input 模块提供游标追踪和去重能力，确保进程重启后能从上次位置继续采集。

## 公共接口 (Public Interface)

### StateStore (`state-store.ts`)
```ts
class StateStore {
  constructor(filePath: string)
  load(): Promise<void>
  save(): Promise<void>
  get(inputId: string): InputState
  set(inputId: string, state: InputState): void
  update(inputId: string, partial: Partial<InputState>): void
  getOffset(inputId: string): number
  setOffset(inputId: string, offset: number): void
  getRowId(inputId: string): number
  setRowId(inputId: string, rowId: number): void
}
```

### SnapshotStore (`snapshot-store.ts`)
```ts
interface SnapshotEntry {
  key: string
  timestamp: number
  seenAt: number
  status: 'pending' | 'processed'
  reason?: string
}

class SnapshotStore {
  constructor(filePath: string, retentionMs?: number)  // default 7 days
  load(): Promise<void>
  flush(): Promise<void>
  shouldProcess(key: string): boolean
  markPending(key: string, timestamp: number): void
  markProcessed(key: string, reason?: string): void
  getSuggestedSinceTimestamp(): number
  get size(): number
}
```

## 内部设计 (Internal Design)

### StateStore
- **存储格式**：JSON 文件 (`input-state.json`)，顶层为 `Record<inputId, InputState>` 映射。
- **Dirty tracking**：仅在状态实际变更时标记 dirty，`save()` 仅 dirty 时写入磁盘。
- **Deep clone**：get/set 操作返回/存储状态的浅拷贝，防止外部引用篡改。
- **多 key 支持**：不仅存储 per-input state，还支持复合 key（如 `inputId:filePath`）用于 per-file offset 追踪。

### InputState 结构
```ts
interface InputState {
  lastOffset?: number     // 字节偏移（Hook/Session inputs）
  lastFile?: string       // 当前处理的日志文件名
  lastRowId?: number      // SQLite rowid 游标
  lastTimestamp?: number  // 时间戳水位
  highWatermark?: number  // 通用水位值
  extra?: Record<string, unknown>  // 扩展字段（如 inode 追踪）
}
```

### SnapshotStore
- **存储格式**：JSON 文件，含 `highWatermark` 和 `entries[]` 数组。
- **去重机制**：通过 key 查找判断是否已处理（`shouldProcess` → `!entries.has(key)`）。
- **两阶段提交**：`markPending()` → 处理 → `markProcessed()`，支持中途失败后下次重试。
- **自动过期清理**：`prune()` 在 `flush()` 时清除 seenAt 超过 `retentionMs` 的条目。
- **High watermark**：取所有 processed entries 中最大 timestamp，用于 `getSuggestedSinceTimestamp()` 优化扫描范围。

### 持久化时机
- **StateStore**：每次 Input collect cycle 结束后调用 `save()`；Orchestrator stop 时最终 save。
- **SnapshotStore**：每次 BaseIdeInput collect 末尾调用 `flush()`；`onStop()` 时最终 flush。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `InputState` |
| utils | `readJsonFile`, `writeJsonFile`, `createLogger` |

## 约束 (Constraints)

1. **单写者模型**：同一 filePath 不得有多个 StateStore/SnapshotStore 实例同时操作。
2. **load() 必须在使用前调用**：未 load 的 store 返回空状态，可能导致数据重复采集。
3. **SnapshotStore key 格式一致性**：同一 Input 的 key 生成逻辑不可变更，否则破坏去重。
4. **retentionMs 不得小于 pollIntervalMs**：否则条目可能在下次 cycle 前被清除导致重复。
5. **flush/save 操作为原子写入**：通过 `writeJsonFile` 确保写入完整性。
6. **extra 字段为 shallow merge**：update 时 extra 对象仅做浅层合并。
