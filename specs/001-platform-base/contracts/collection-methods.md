# Contract: 采集方式与数据流

**Module**: `src/inputs/`

## 采集方式一览

| 采集方式 | 基类 | 数据源格式 | 游标类型 | 当前 Agent |
|---------|------|----------|---------|-----------|
| IDE 快照轮询 | BaseIdeInput | VS Code History entries.json + SQLite + JSONL | SnapshotStore (key 去重) + StateStore (辅助 offset) | Qoder |
| SQLite 增量轮询 | BaseSqliteInput | SQLite 数据库 | StateStore (rowid) | (可用, 未绑定 Agent) |
| Hook JSONL 日志 | BaseHookInput | 每日轮转 JSONL 文件 | StateStore (byte offset) | Qoder CLI |
| CLI 遥测转发 | BaseCliForwarder | 原始遥测文件 → 每日 JSONL | StateStore (byte offset) | (可用, 未绑定 Agent) |
| 会话文件轮询 | BaseSessionInput | JSONL 会话文件 | StateStore (byte offset + inode) | Qoder Work, Openclaw |

## 数据流 (统一路径)

```text
Agent 数据源 (文件/SQLite)
        │
        ▼
  具体输入源.collect()
    ├── 读取新增数据 (基于游标/offset)
    ├── 过滤无关记录
    ├── 调用 buildAgentActivityEntry() 归一化
    └── 更新 StateStore 游标
        │
        ▼
  BaseInput.runCycle()
    ├── emit('entries', AgentActivityEntry[])
    └── stateStore.save()
        │
        ▼
  InputManager.handleEntries()
    ├── 填充 userId
    └── flusher.sendBatch()
        │
        ▼
  MultiFlusher.sendBatch()
    ├── serialiseLogEntry() → SerializedLogEntry
    ├── JSONL: appendLine(JSON.stringify({...}))
    ├── SLS: enqueue → batch flush → postLogStoreLogs()
    └── HTTP: buffer → batch flush → axios.post()
```

## 新增 Agent 的接入契约

新增一个 Agent 输入源需要且仅需要：

1. **声明 ClientType**: 在 `src/types/client-type.ts` 枚举中添加
2. **实现 Input 类**: 继承合适的基类，实现抽象方法
3. **注册到 Orchestrator**: 在 `orchestrator.ts` 的 `registerAllInputs()` 中添加

**禁止**: 修改任何基类、现有输入源或输出通道的代码。
