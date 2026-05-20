# 输入源层 (src/inputs/)

> 6 种采集基类覆盖不同 Agent 的数据获取方式，每个 Agent 只需继承基类并实现 2-3 个抽象方法。

## 基类体系

```
BaseInput (根抽象类: 生命周期 / 定时 / 事件)
├── BaseIdeInput         IDE 历史快照轮询
├── BaseSqliteInput      SQLite 增量轮询
├── BaseHookInput        Hook JSONL 日志
├── BaseCliForwarder     CLI 遥测日志转发
└── BaseSessionInput     会话文件轮询
```

## 各基类职责与抽象方法

| 基类 | 数据来源 | 需实现方法 | 游标类型 |
|------|---------|-----------|---------|
| `BaseIdeInput` | IDE 本地 History 文件 | `scanHistoryEntries()`, `buildEntry()` | SnapshotStore |
| `BaseSqliteInput` | 本地 SQLite DB | `readNewRows()`, `transformRow()` | StateStore (rowId) |
| `BaseHookInput` | Hook 产生的 JSONL 文件 | `transformRecord()` | StateStore (byte offset) |
| `BaseCliForwarder` | Agent 遥测输出文件 | `isRelevantEvent()`, `transformPayload()` | StateStore (byte offset) |
| `BaseSessionInput` | JSONL/JSON 会话记录 | `discoverSessionFiles()`, `processSessionLine()` | StateStore (byte offset) |

## Input 实现清单

| 目录 | Agent | 基类 | 说明 |
|------|-------|------|------|
| `inputs/qoder/` | Qoder IDE | BaseIdeInput | 扫描 VSCode History 快照 |
| `inputs/qoder-sqlite/` | Qoder Work | BaseSqliteInput | 查询本地 SQLite |
| `inputs/qoder-work/` | Qoder Work | BaseHookInput | Hook JSONL 采集 |
| `inputs/qoder-work-log/` | Qoder Work | BaseHookInput | Hook 日志采集 |
| `inputs/qoder-work-sqlite/` | Qoder Work | BaseSqliteInput | SQLite 变体 |
| `inputs/qoder-cli/` | Qoder CLI | BaseHookInput | CLI Hook JSONL |
| `inputs/qoder-cli-session/` | Qoder CLI | BaseSessionInput | 会话文件轮询 |
| `inputs/cursor-hook/` | Cursor | BaseHookInput | Cursor Hook JSONL |
| `inputs/claude-code-log/` | Claude Code | BaseHookInput | OTel 插件 JSONL |
| `inputs/codex-log/` | Codex | BaseHookInput | OTel 插件 JSONL |

## BaseInput 生命周期

<!-- TODO: 描述 Input 的完整生命周期（init → start → poll → stop → destroy） -->
<!-- TODO: 描述定时轮询机制和 pollInterval 配置 -->
<!-- TODO: 描述错误处理策略（单条失败不中断整体采集） -->

## BaseHookInput 详解

<!-- TODO: 描述 JSONL 文件发现和增量读取机制 -->
<!-- TODO: 描述文件轮转时的偏移重置逻辑 -->
<!-- TODO: 描述 inode 检测（文件被替换时的处理） -->

## BaseIdeInput 详解

<!-- TODO: 描述 VSCode History 目录结构和扫描逻辑 -->
<!-- TODO: 描述 SnapshotStore 去重机制的集成方式 -->
<!-- TODO: 描述 AI 来源过滤（只采集 AI 生成的修改） -->

## BaseSqliteInput 详解

<!-- TODO: 描述 SQLite 增量查询策略（rowId 游标） -->
<!-- TODO: 描述数据库文件锁定和并发读取处理 -->

## 添加新 Input

<!-- TODO: 简要描述添加新 Input 的三步流程（声明 ClientType → 实现 Input → 注册到 Orchestrator） -->
<!-- TODO: 指向 docs/agent-onboarding-guide.md 获取完整指南 -->
