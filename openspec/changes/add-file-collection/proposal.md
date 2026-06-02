## Why

当前 loongsuite-pilot 的数据采集链路专注于 AI coding agent 的活动数据：从 IDE 历史、SQLite、Hook JSONL、Session 日志中采集数据，标准化为 `AgentActivityEntry`，再通过 `MultiFlusher` 输出到 SLS/JSONL/HTTP。

现在需要新增**本地文件采集能力**：将任意日志文件的内容逐行读取并上传到 SLS。这是一条与 agent activity 采集完全不同的数据管道：
- 数据格式不同：原始日志行，不需要 `AgentActivityEntry` 标准化
- 输出目标不同：每个采集配置指向独立的 SLS project/logstore
- 隔离要求不同：每个配置的采集、发送、状态、错误处理完全独立

典型场景：采集开发机上的应用日志、系统日志、测试日志等，上传到不同的 SLS 目标进行分析。

## What Changes

- **新模块 `src/file-collection/`**：与现有 agent activity 管道并行的独立文件采集管道
- **`FileCollectionManager`**：监控配置目录 `~/.loongsuite-pilot/file-collection/`，动态加载/卸载采集 pipeline
- **`FilePipeline`**：每个配置文件对应一个独立的 pipeline 实例，包含文件发现、逐行读取、SLS 发送、checkpoint 持久化
- **`FileTailer`**：文件发现（glob 通配符）+ 增量逐行读取 + 日志轮转处理（rename 和 copytruncate 两种模式）
- **`FileSlsSender`**：基于 WebTracking 模式的 SLS 发送器，复用从 `SlsFlusher` 抽取的 `sls-transport` 公共传输层
- **反压机制**：有界缓冲区 + 水位线控制，发送慢时自动暂停读取
- **SLS 传输层抽取**：将 `SlsFlusher` 中的 WebTracking POST、分片、重试、失败持久化逻辑抽取到 `src/flushers/sls-transport.ts`，供 `SlsFlusher` 和 `FileSlsSender` 共用

## Capabilities

### New Capabilities
- `file-collection`：本地文件采集管道 — 配置动态加载、glob 文件发现、增量逐行读取、日志轮转处理（rename + copytruncate）、反压控制、WebTracking SLS 发送、per-config 状态隔离与失败持久化

### Modified Capabilities
- `sls-transport`（内部重构）：从 `SlsFlusher` 抽取 WebTracking 传输层为独立模块，原有行为不变

## Impact

- **Code**:
  - `src/file-collection/file-collection-manager.ts`（新）— 配置目录监控 + pipeline 生命周期管理
  - `src/file-collection/file-pipeline.ts`（新）— 单个采集配置的完整 pipeline
  - `src/file-collection/file-tailer.ts`（新）— 文件发现 + 增量读取 + 轮转处理
  - `src/file-collection/file-sls-sender.ts`（新）— WebTracking SLS 原始日志发送
  - `src/file-collection/types.ts`（新）— 配置类型定义
  - `src/flushers/sls-transport.ts`（新）— 抽取的 SLS WebTracking 公共传输层
  - `src/flushers/sls-flusher.ts`（修改）— 改为调用 `sls-transport` 中的公共方法
  - `src/core/orchestrator.ts`（修改）— 新增步骤启动 `FileCollectionManager`
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
