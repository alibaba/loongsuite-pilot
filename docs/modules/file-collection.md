# Module: file-collection

> Last verified: 2026-06-02

## 职责 (Responsibility)

本地文件采集管道，将任意日志文件的内容逐行读取并上传到 SLS。与 agent activity 管道完全独立，支持多配置并行运行，每个配置拥有独立的采集、发送、状态、错误处理链路。

## 公共接口 (Public Interface)

- **FileCollectionManager** — 配置目录监控 + pipeline 生命周期管理。监控 `~/.loongsuite-pilot/file-collection/` 目录，动态加载/卸载采集 pipeline。
- **FilePipeline** — 单个采集配置的完整 pipeline，包含文件发现、逐行读取、SLS 发送、checkpoint 持久化。
- **FileTailer** — 文件发现（glob 通配符）+ 增量逐行读取 + 日志轮转处理（rename 和 copytruncate 两种模式）。
- **FileSlsSender** — 基于 WebTracking 模式的 SLS 发送器，复用 `sls-transport` 公共传输层。

## 不负责 (NOT Responsible For)

- Agent activity 数据采集 → inputs 模块负责
- AgentActivityEntry 标准化 → normalization 模块负责
- SLS WebTracking HTTP 传输层实现 → flushers/sls-transport 模块负责
- 配置文件的创建和管理 → 用户负责

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/file-collection/
├── types.ts                    # 配置和 checkpoint 类型定义
├── file-collection-manager.ts  # 配置目录监控 + pipeline 生命周期
├── file-pipeline.ts            # 单个配置的完整 pipeline
├── file-tailer.ts              # 文件发现 + 增量读取 + 轮转处理
└── file-sls-sender.ts          # WebTracking SLS 原始日志发送
```

### 运行时目录布局

```
~/.loongsuite-pilot/
├── configs/local/                      ← 配置目录（用户管理）
│   ├── sample-file-config.json
│   └── nginx-access.json
├── state/file-collection/              ← 每配置独立状态
│   └── <configName>.json
├── logs/
│   └── file-collection-failed/         ← 每配置独立失败日志
│       └── <configName>.jsonl
```

### Pipeline 隔离模型

每个 `FilePipeline` 拥有独立的 `FileTailer`、`FileSlsSender`、`StateStore`、buffer 和失败日志。

### 配置动态加载

`FileCollectionManager` 使用 `fs.watch` 监控配置目录 + 每 60s 全量 rescan 兜底。配置新增/删除/修改时自动创建/销毁/重建 pipeline。

### 日志轮转处理

- **copytruncate**：inode 不变 + size < offset → offset 归零
- **rename**：inode 变化 → 按旧 inode 查找旧文件追尾 → 新文件从头读

### 反压机制

有界 buffer（HIGH_WATERMARK = 8000 条），达到时暂停新文件读取。旧文件追尾不受反压限制。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| flushers/sls-transport | `postWebtracking`, `persistFailedLogs`, `SlsTransportConfig` |
| checkpoints | `StateStore` |
| utils | `createLogger`, `ensureDir` |

## 配置 (Configuration)

文件采集功能默认关闭，需要显式启用：

- **配置文件** (`~/.loongsuite-pilot/config.json`)：
  ```json
  { "fileCollection": { "enabled": true } }
  ```
- **环境变量**：`LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED=true`

环境变量优先级高于配置文件。未配置时默认为 `false`。

## 约束 (Constraints)

1. **每个 pipeline 完全隔离**：state、flusher、buffer、失败日志互不共享。
2. **仅支持 WebTracking 模式**：不支持 AK 签名模式。
3. **不经过 AgentActivityEntry 标准化**：数据格式为原始日志行 `{ content: "..." }`。
4. **单次读取上限 4MB**：防止大文件导致内存暴涨。
5. **末尾不完整行不采集**：只推进 offset 到最后一个 `\n`。
6. **单次 cycle 最多处理 100 个文件**：防止 glob 匹配到大量文件时单个 cycle 耗时过长。
