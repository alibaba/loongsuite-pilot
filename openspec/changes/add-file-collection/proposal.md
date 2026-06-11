## Why

当前 loongsuite-pilot 的数据采集链路专注于 AI coding agent 的活动数据：从 IDE 历史、SQLite、Hook JSONL、Session 日志中采集数据，标准化为 `AgentActivityEntry`，再通过 `MultiFlusher` 输出到 SLS/JSONL/HTTP。

现在需要新增**本地文件采集能力**：将任意日志文件的内容逐行读取并上传到 SLS。这是一条与 agent activity 采集完全不同的数据管道：
- 数据格式不同：原始日志行，不需要 `AgentActivityEntry` 标准化
- 输出目标不同：每个采集配置指向独立的 SLS project/logstore
- 隔离要求不同：每个配置的采集、发送、状态、错误处理完全独立

典型场景：采集开发机上的应用日志、系统日志、测试日志等，上传到不同的 SLS 目标进行分析。

## What Changes

- **新模块 `src/file-collection/`**：与现有 agent activity 管道并行的独立文件采集管道，参考 ilogtail 核心引擎架构重新设计
- **`FileCollectionManager`**：监控配置目录 `~/.loongsuite-pilot/configs/local/`，动态加载/卸载采集 pipeline
- **`FilePipeline`**：每个配置文件对应一个独立的 pipeline 实例，整合事件驱动监控 + 时间片控制 + 反压读取
- **`FileWatcher`**（新增）：基于 `fs.watch` 的事件驱动文件监控，维护 dirtyFiles set，降级到 polling 兜底
- **`FileTailer`**：文件发现（glob）+ 增量逐行读取 + Reader 队列管理 + 签名优化 + 不完整行缓存
- **`FileSlsSender`**：基于 WebTracking 模式的 SLS 发送器，复用 `sls-transport` 公共传输层，反压改造（enqueue 拒绝写入）
- **事件驱动 + Polling 双层监控**：fs.watch 实时感知文件变更 + 30s 兜底 rescan，降低延迟和 CPU 开销
- **读取-发送异步解耦**：通过 FileSlsSender 有界 buffer 解耦，反压逐级传导
- **Reader 队列**：轮转时旧文件和新文件可并行追踪（最简版，max length 3）
- **时间片控制**：单文件最多 50ms，防止大文件阻塞其他文件读取
- **增强 Checkpoint**：增加 DevInode、签名、不完整行缓存、最后更新时间
- **SLS 传输层抽取**：将 `SlsFlusher` 中的 WebTracking POST、分片、重试、失败持久化逻辑抽取到 `src/flushers/sls-transport.ts`，供 `SlsFlusher` 和 `FileSlsSender` 共用

## Capabilities

### New Capabilities
- `file-collection`：本地文件采集管道 — 事件驱动 + polling 双层文件监控、glob 文件发现、Reader 队列轮转追踪、时间片控制、读写异步解耦反压、增强 checkpoint（DevInode/签名/缓存）、WebTracking SLS 发送、per-config 状态隔离与失败持久化

### Modified Capabilities
- `sls-transport`（内部重构）：从 `SlsFlusher` 抽取 WebTracking 传输层为独立模块，原有行为不变

## Impact

- **Code**:
  - `src/file-collection/file-watcher.ts`（新增）— fs.watch 事件驱动文件监控 + dirtyFiles 管理
  - `src/file-collection/file-collection-manager.ts`（已实现）— 配置目录监控 + pipeline 生命周期管理
  - `src/file-collection/file-pipeline.ts`（重构）— 整合 FileWatcher + 时间片控制 + 事件驱动 pollCycle
  - `src/file-collection/file-tailer.ts`（重构）— Reader 队列 + 签名优化 + 不完整行缓存 + hasMore 返回
  - `src/file-collection/file-sls-sender.ts`（重构）— enqueue 返回 boolean 反压 + isBackpressured()
  - `src/file-collection/types.ts`（增强）— DevInode、FileReaderState、增强 FileCheckpoint
  - `src/flushers/sls-transport.ts`（已实现）— 抽取的 SLS WebTracking 公共传输层
  - `src/flushers/sls-flusher.ts`（已重构）— 改为调用 `sls-transport` 中的公共方法
  - `src/core/orchestrator.ts`（已修改）— 新增步骤启动 `FileCollectionManager`
- **Affected Baseline Modules**:
  - `docs/modules/flushers.md` — 新增 `sls-transport` 公共传输层说明
  - `docs/modules/core.md` — Orchestrator 启动步骤新增 FileCollectionManager
  - `AGENTS.md` — 架构总览增加 File Collection 模块
- **Dependencies (new)**: 无新外部依赖（glob 使用 Node.js 内置 `fs.glob` 或 `path` 模块 + 手工匹配）
- **Baseline Modification**: 需要更新。新增模块 `file-collection` 是全新的并行管道，需要在架构文档中记录其职责和边界。`sls-transport` 的抽取改变了 `flushers` 模块的内部结构。
- **Baseline Documentation Updates**:
  - 新增 `docs/modules/file-collection.md` — 文件采集模块文档
  - 更新 `docs/modules/flushers.md` — 新增 sls-transport 公共传输层
  - 更新 `docs/modules/core.md` — Orchestrator 新增 FileCollectionManager 步骤
  - 更新 `AGENTS.md` — 架构总览增加 File Collection 模块
