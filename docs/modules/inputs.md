# Module: inputs

> Last verified: 2026-05-13

## 职责 (Responsibility)

数据采集层，通过多种策略从 AI coding agents 的本地存储中增量提取活动数据并发射标准化 entries。

## 公共接口 (Public Interface)

- **BaseInput** — 所有 Input 的抽象基类，定义了统一的生命周期（start/stop）、标识信息（id、agentType、collectionMethod）和数据发射机制。继承 EventEmitter，通过 entries 事件输出采集结果。
- **BaseIdeInput** — IDE 本地文件快照轮询策略的基类，子类需实现历史条目扫描和单条目构建逻辑，配合 SnapshotStore 实现去重。
- **BaseSqliteInput** — SQLite rowid 游标增量查询策略的基类，子类需实现新行读取和行转换逻辑。
- **BaseHookInput** — Hook JSONL 日志字节偏移增量读取策略的基类，子类需实现原始记录到标准 entry 的转换。
- **BaseSessionInput** — Session 文件轮询策略的基类，支持 inode rotation 检测，子类需实现文件发现和行解析逻辑。
- **BaseCliForwarder** — CLI 遥测日志转发策略的基类，子类需实现事件过滤和 payload 转换逻辑。

## 不负责 (NOT Responsible For)

- 数据标准化或转换 → normalization 模块负责
- 数据输出/刷新 → flushers 模块负责
- 配置加载与解析 → core 模块 (config-loader) 负责
- Hook 脚本安装 → hooks 模块负责
- 状态存储的序列化格式 → checkpoints 模块负责

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/inputs/
├── base/
│   ├── base-input.ts
│   ├── base-ide-input.ts
│   ├── base-sqlite-input.ts
│   ├── base-hook-input.ts
│   ├── base-session-input.ts
│   └── base-cli-forwarder.ts
├── qoder/                  # IDE snapshot polling
├── qoder-sqlite/           # SQLite token usage polling
├── qoder-cli/              # Hook JSONL input
├── qoder-cli-session/      # Native session file polling
├── qoder-work/             # Hook JSONL input (parameterized: QoderWork + QoderWork CN)
├── qoder-work-log/         # SDK log tail (parameterized: QoderWork + QoderWork CN)
├── qoder-work-sqlite/      # SQLite agents.db (parameterized: QoderWork + QoderWork CN)
├── cursor-hook/            # Cursor hook history input
├── claude-code-log/        # OTel plugin JSONL input
├── codex-log/              # OTel plugin JSONL input
└── wukong/                 # CLI API polling (Wukong desktop app)
```

每个 concrete input 目录通常只暴露一个 `<agent>-input.ts`，并通过 static `getWatchPaths()` / `checkAvailability()` 与 `AgentDiscoveryService` 对接。

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

2. **创建实现文件** `src/inputs/<agent-name>/<agent-name>-input.ts`：创建新 Input 需要继承对应的 Base class 并实现其 lifecycle 方法。参考现有实现: [src/inputs/qoder/qoder-input.ts](../../../src/inputs/qoder/qoder-input.ts)

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
