# Data Model: 平台基础设施（Platform Base）

**Feature**: `001-platform-base`
**Date**: 2026-04-27

## 实体关系概览

```text
┌──────────────────────────────────────────────────────────────────┐
│                         Orchestrator                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ConfigLoader  │  │AgentControl  │  │AgentDiscoveryService    │ │
│  │(config.json) │  │Manager       │  │(fs.watch + polling)     │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐                    ┌─────────────────────────┐ │
│  │ InputManager │──── manages ──────▶│  BaseInput (abstract)   │ │
│  │              │                    │  ├── BaseIdeInput        │ │
│  │              │                    │  ├── BaseSessionInput    │ │
│  │              │                    │  ├── BaseHookInput       │ │
│  │              │                    │  ├── BaseSqliteInput     │ │
│  │              │                    │  └── BaseCliForwarder    │ │
│  └──────┬───────┘                    └──────────┬──────────────┘ │
│         │ dispatches                            │ uses           │
│         ▼                                       ▼               │
│  ┌──────────────┐         ┌──────────────┐ ┌────────────────┐   │
│  │ MultiFlusher │         │  StateStore   │ │ SnapshotStore  │   │
│  │  ├── JSONL   │         │  (共享)       │ │ (per-agent)    │   │
│  │  ├── SLS     │         └──────────────┘ └────────────────┘   │
│  │  └── HTTP    │                                               │
│  └──────────────┘                                               │
└──────────────────────────────────────────────────────────────────┘

All inputs emit ──▶ AgentActivityEntry[] ──▶ serialiseLogEntry() ──▶ Flusher
```

## 实体定义

### AgentActivityEntry（活动记录）

归一化后的标准输出格式，所有输入源的统一产出物。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| uuid | string | ✅ | 全局唯一标识 (UUIDv4) |
| sessionId | string | ✅ | 会话标识 |
| timestamp | number | ✅ | 事件时间戳 (毫秒) |
| userId | string | ✅ | 用户标识 (可由上游填充) |
| agentType | ClientType | ✅ | Agent 类型枚举值 |
| actionType | ActionType | ✅ | 操作类型枚举值 |
| filePath | string | ✅ | 关联的文件路径 |
| content | string | ❌ | 代码内容 |
| inlineDiffMessage | string | ❌ | 差异信息 |
| git | GitContext | ❌ | Git 仓库上下文 (由 InputManager 富化) |
| extra | Record<string, unknown> | ❌ | Agent 特有的扩展字段 |

**验证规则**:
- `uuid` 必须为合法 UUIDv4 格式
- `timestamp` 必须为正整数（毫秒精度）
- `agentType` 必须为 `ClientType` 枚举的有效值
- `actionType` 必须为 `ActionType` 枚举的有效值

### SerializedLogEntry（序列化记录）

活动记录经序列化后的扁平字符串键值对，是所有输出通道的统一传输格式。

| 字段 | 类型 | 来源 |
|------|------|------|
| sessionId | string | 直接映射 |
| timestamp | string | 毫秒级字符串（秒级自动 ×1000） |
| uuid | string | 直接映射 |
| userId | string | 直接映射 |
| agentType | string | 直接映射 |
| actionType | string | 直接映射 |
| filePath | string | 直接映射 |
| content | string | 可选，仅非空时输出 |
| inlineDiffMessage | string | 可选，仅非空时输出 |
| repoId | string | 展平自 git.repoId |
| branchName | string | 展平自 git.branchName |
| commitHash | string | 展平自 git.commitHash |
| *{extraKey}* | string | extra 中非过滤键，值转字符串 |

**过滤键集合**: `filePath`, `content`, `inlineDiffMessage`, `recorduuid`, `distinctid`

### InputState（输入状态）

单个输入源的采集进度快照，由 `StateStore` 管理。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| lastOffset | number | ❌ | 文件读取字节偏移量 (Hook/Session 输入源) |
| lastRowId | number | ❌ | SQLite 最后查询的 rowid |
| lastTimestamp | number | ❌ | 最后处理的事件时间戳 |
| highWatermark | number | ❌ | 已处理的最大时间戳 |
| extra | Record<string, unknown> | ❌ | 自定义扩展 (如 inode) |

**状态键约定**:
- 基本键: `{inputId}` (如 `'qoder'`, `'qoder-work-hook'`)
- 组合键: `{inputId}:{subResource}` (如 `'qoder-tracker:filename.jsonl'`)

### SnapshotEntry（快照条目）

IDE 快照去重存储中的单条记录。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| key | string | ✅ | 唯一去重键 (`filePath@@timestamp@@agentType`) |
| timestamp | number | ✅ | 事件时间戳 |
| seenAt | number | ✅ | 首次发现时间 |
| status | 'pending' \| 'processed' | ✅ | 处理状态 |
| reason | string | ❌ | 处理结果说明 |

**状态转换**:

```text
(不存在) ──shouldProcess()──▶ (不存在, return true)
                                    │
                              markPending()
                                    │
                                    ▼
                               [pending]
                                    │
                              markProcessed()
                                    │
                                    ▼
                              [processed]
                                    │
                            (seenAt > retentionMs)
                                    │
                                prune()
                                    │
                                    ▼
                               (已删除)
```

### CodeGenerationEvent（代码生成事件）

IDE 输入源扫描产出的中间结构，在转为 `AgentActivityEntry` 前使用。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentType | ClientType | ✅ | Agent 类型 |
| filePath | string | ✅ | 被编辑的文件路径 |
| actionType | ActionType | ✅ | 操作类型 |
| content | string | ❌ | 代码内容 |
| diff | string | ❌ | 差异信息 |
| sourceTimestamp | number | ✅ | 原始事件时间戳 |
| rawData | Record<string, unknown> | ❌ | 原始数据 (透传到 extra) |

### AnalyticsConfig（全局配置）

| 字段 | 类型 | 说明 |
|------|------|------|
| enabled | boolean | 全局开关 |
| autoStart | boolean | 是否自动启动 |
| dataDir | string | 数据目录根路径 |
| listeners | Record<string, ListenerConfig> | 各 Agent 轮询配置 |
| flushers | FlusherConfig | 输出通道配置 |

### AgentDetectionEntry（检测条目）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | Agent 唯一标识 |
| type | string | 采集方式 |
| isAvailable | () => Promise<boolean> | 可用性检测回调 |
| watchPaths | string[] | fs.watch 监听路径 |
| enabled | () => boolean | 准入控制回调 |
| start | () => Promise<void> | 启动回调 |
| stop | () => Promise<void> | 停止回调 |
| pollIntervalMs | number | 轮询间隔 |

### EntryState（发现服务状态机）

```text
idle ──▶ starting ──▶ running ──▶ stopping ──▶ idle
```

### ClientType（枚举）

| 值 | 说明 |
|----|------|
| Qoder | Qoder IDE |
| QoderWork | Qoder Work |
| QoderCliHook | Qoder CLI (Hook) |

### ActionType（枚举）

| 值 | 说明 |
|----|------|
| Create | 创建文件 |
| Edit | 编辑文件 |
| Delete | 删除文件 |
| Execute | 执行命令 |
| Read | 读取文件 |
| Search | 搜索 |
| Browse | 浏览网页 |
| Other | 其他 |

### CollectionMethod（枚举）

| 值 | 对应基类 | 说明 |
|----|---------|------|
| IdeSnapshotPolling | BaseIdeInput | IDE 历史快照轮询 |
| SqlitePolling | BaseSqliteInput | SQLite 增量轮询 |
| HookJsonl | BaseHookInput | Hook JSONL 日志 |
| CliTelemetryForwarding | BaseCliForwarder | CLI 遥测转发 |
| SessionFilePolling | BaseSessionInput | 会话文件轮询 |
