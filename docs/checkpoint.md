# 持久化层 (src/checkpoints/)

> 在进程重启之间保存采集状态，避免数据重复采集或丢失。

## 模块组成

| 文件 | 职责 |
|------|------|
| `state-store.ts` | 输入源偏移量/游标状态管理 |
| `snapshot-store.ts` | 快照去重（pending/processed 状态机） |

## StateStore — 输入源进度跟踪

**存储位置**：`~/.loongsuite-pilot/logs/input-state.json`

```
┌─────────────┐     getOffset()      ┌───────────────────┐
│  Input 实例  │ ◄──────────────────── │    StateStore     │
│             │ ────────────────────► │                   │
└─────────────┘     setOffset()      │  (内存 Map +      │
                                     │   dirty 写盘)     │
                                     └───────────────────┘
```

<!-- TODO: 描述 StateStore 的完整 API（getOffset/setOffset/getRowId/setRowId/update） -->
<!-- TODO: 描述 dirty flag 优化（仅变更时才写盘） -->
<!-- TODO: 描述启动时加载和停止时持久化的时序 -->

## SnapshotStore — 事件去重

**存储位置**：`~/.loongsuite-pilot/logs/snapshot-store.json`

```
shouldProcess(key)? ─── 否 ──→ 跳过（已处理过）
       │
       是
       ▼
markPending(key) → 处理数据 → markProcessed(key)
```

<!-- TODO: 描述去重 Key 的构建规则（filePath@@timestamp@@agentType） -->
<!-- TODO: 描述 pending → processed 状态机 -->
<!-- TODO: 描述 highWatermark 机制和重启恢复策略 -->
<!-- TODO: 描述 retentionMs 过期清理逻辑 -->

## 两个 Store 的协作

<!-- TODO: 描述哪些 Input 使用 StateStore、哪些使用 SnapshotStore -->
<!-- TODO: 描述两者互补的设计考量 -->
