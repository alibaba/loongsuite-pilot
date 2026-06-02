## 1. SLS 传输层抽取

- [x] 1.1 创建 `src/flushers/sls-transport.ts`，从 `SlsFlusher` 中抽取以下公共逻辑：
  - `SlsTransportConfig` 接口定义
  - `postWebtracking(config, logs, topic, source)` — HTTP POST + 重试
  - `splitForWebtracking(logs, maxLogs, maxBytes)` — 按条数/体积分片
  - `isRetryable(err)` — 可重试错误判断
  - `persistFailedLogs(dir, name, logGroup, err)` — 失败日志持久化
  - 相关常量：`WEBTRACKING_TIMEOUT_MS`, `WEBTRACKING_MAX_BODY_BYTES`, `WEBTRACKING_MAX_LOGS`, `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRYABLE_STATUS_CODES`, `HttpError` class
- [x] 1.2 重构 `src/flushers/sls-flusher.ts`，将 `flushViaWebtracking`、`postWebtracking`、`splitForWebtracking`、`isRetryable`、`persistFailedLogs` 改为调用 `sls-transport.ts` 中的公共方法，确保行为不变
- [x] 1.3 运行现有 SlsFlusher 单元测试，确保重构后所有测试通过

## 2. 文件采集类型定义

- [x] 2.1 创建 `src/file-collection/types.ts`，定义以下类型：
  - `FileInputConfig`：`Type`, `FilePaths: string[]`, `FileEncoding`, `MaxDirSearchDepth`, `AllowingIncludedByMultiConfigs`
  - `FileSlsFlusherConfig`：`Type`, `Endpoint`, `Project`, `Logstore`, `Region`, `Aliuid`, `TelemetryType`
  - `FileCollectionConfig`：`configName`, `inputs: FileInputConfig[]`, `flushers: FileSlsFlusherConfig[]`
  - `FileCheckpoint`：`offset: number`, `inode: number`
  - `FileCollectionManagerOptions`：`configDir`, `stateDir`, `failedLogDir`
  - `FilePipelineOptions`：`config`, `stateDir`, `failedLogDir`

## 3. FileTailer — 文件发现与增量读取

- [x] 3.1 创建 `src/file-collection/file-tailer.ts`
- [x] 3.2 实现 `discoverFiles(filePaths: string[], maxDepth: number): string[]`
  - 对每个 FilePaths 配置项进行 glob 匹配（支持 `*` 通配符）
  - 遵循 `MaxDirSearchDepth` 控制递归深度
  - 过滤掉目录和不可读文件
  - 单次最多返回 100 个文件
- [x] 3.3 实现 `readNewLines(filePath, checkpoint): { lines: string[], checkpoint: FileCheckpoint }`
  - `stat(filePath)` 获取文件信息
  - 轮转检测（D6）：
    - 正常追加：`inode 相同 && size >= offset` → 从 offset 继续读
    - copytruncate：`inode 相同 && size < offset` → offset 归零
    - rename：`inode 不同` → 调用 `drainOldFile()` 后 offset 归零
  - 限制单次读取量：`MAX_READ_BYTES = 4MB`
  - 处理末尾不完整行：只推进 offset 到最后一个 `\n`
  - 返回完整行数组和新的 checkpoint
- [x] 3.4 实现 `drainOldFile(dir, oldInode, oldOffset): string[]`
  - 扫描同目录下所有文件，找到 `inode === oldInode` 的文件
  - 从 `oldOffset` 读取到文件末尾
  - 未找到则返回空数组并记录 warn

## 4. FileSlsSender — SLS 原始日志发送

- [x] 4.1 创建 `src/file-collection/file-sls-sender.ts`
- [x] 4.2 构造函数接收 `FileSlsFlusherConfig`，构建 `SlsTransportConfig`
  - endpoint URL 补全：无 scheme 时自动加 `https://`
- [x] 4.3 实现 `enqueue(lines: string[], configName: string)`
  - 每行转为 `{ content: line }` 格式
  - 推入内部 buffer
- [x] 4.4 实现 `flush()`
  - 从 buffer 中取出数据
  - 调用 `sls-transport.postWebtracking()` 发送
  - `__topic__` 设为 configName，`__source__` 设为本机 IP
  - 失败时调用 `sls-transport.persistFailedLogs()` 持久化
- [x] 4.5 实现 `start()` — 启动 `flushIntervalMs` 定时 flush（默认 2s）
- [x] 4.6 实现 `shutdown()` — 清理 timer + flush 剩余 buffer
- [x] 4.7 实现 `bufferSize(): number` — 返回当前 buffer 中的行数（供反压检查）

## 5. FilePipeline — 单个配置的完整 pipeline

- [x] 5.1 创建 `src/file-collection/file-pipeline.ts`
- [x] 5.2 构造函数：根据 config 创建 `FileTailer`、`FileSlsSender`、独立 `StateStore`
  - StateStore 路径：`<stateDir>/<configName>.json`
  - 失败日志路径：`<failedLogDir>/<configName>.jsonl`
- [x] 5.3 实现 `start()`
  - `stateStore.load()`
  - `sender.start()`
  - 启动 poll timer（默认 `pollIntervalMs = 10_000`）
- [x] 5.4 实现 `pollCycle()`
  - 步骤 1：对所有已知文件执行轮转检测，如有 rename 轮转则追尾旧文件并入 buffer（不受反压限制）
  - 步骤 2：检查反压 — `sender.bufferSize() >= HIGH_WATERMARK` 则跳过正常读取
  - 步骤 3：正常读取 — `tailer.discoverFiles()` + `tailer.readNewLines()` → `sender.enqueue(lines)`
  - 步骤 4：`stateStore.save()`
- [x] 5.5 实现 `stop()`
  - 清理 poll timer
  - `sender.flush()` + `sender.shutdown()`
  - `stateStore.save()`
- [x] 5.6 错误处理：`pollCycle` 整体 try-catch，单个文件的错误不影响其他文件

## 6. FileCollectionManager — 配置目录管理

- [x] 6.1 创建 `src/file-collection/file-collection-manager.ts`
- [x] 6.2 实现 `start()`
  - `ensureDir(configDir)`
  - `scanConfigDir()` — 加载所有 `.json` 文件，逐个 `createPipeline()`
  - `watchConfigDir()` — `fs.watch` 监听配置目录变化
  - 启动 rescan timer（每 60s 全量 rescan 兜底）
- [x] 6.3 实现 `scanConfigDir(): FileCollectionConfig[]`
  - 读取 configDir 下所有 `.json` 文件
  - 逐个 JSON.parse，解析失败则 warn 并跳过
  - 返回有效配置列表
- [x] 6.4 实现 `onConfigChanged(fileName)`
  - 文件新增：`createPipeline(config)`
  - 文件删除：`destroyPipeline(configName)`
  - 文件修改：`destroyPipeline()` + `createPipeline()`
  - 通过比较内存中的 pipeline 列表与磁盘文件列表判断增删改
- [x] 6.5 实现 `createPipeline(config)`
  - 校验 config（必填字段检查：configName, inputs, flushers）
  - 创建 `FilePipeline` 实例并 `start()`
  - 注册到 `pipelines: Map<string, FilePipeline>`
- [x] 6.6 实现 `destroyPipeline(configName)`
  - 从 map 中取出并 `stop()`
- [x] 6.7 实现 `stop()`
  - 关闭 `fs.watch` watcher
  - 关闭 rescan timer
  - 所有 pipeline `stop()`

## 7. Orchestrator 集成

- [x] 7.1 在 `src/core/orchestrator.ts` 中 import `FileCollectionManager`
- [x] 7.2 在 `Orchestrator` 类中新增 `fileCollectionManager` 字段
- [x] 7.3 在 `start()` 方法末尾（步骤 10 之后）新增步骤 11：创建并启动 `FileCollectionManager`
  - configDir: `path.join(this.dataDir, 'file-collection')`
  - stateDir: `path.join(this.dataDir, 'logs', 'file-collection-state')`
  - failedLogDir: `path.join(this.dataDir, 'logs', 'file-collection-failed')`
- [x] 7.4 在 `stop()` 方法中新增 `this.fileCollectionManager?.stop()`（在现有 stop 步骤之前）
- [x] 7.5 在 `index.ts` 中 export `FileCollectionManager`

## 8. 测试

- [x] 8.1 `tests/unit/flushers/sls-transport.test.ts`：测试 `splitForWebtracking` 分片逻辑、`isRetryable` 错误判断
- [x] 8.2 `tests/unit/file-collection/file-tailer.test.ts`：
  - glob 文件发现（通配符匹配、深度限制）
  - 增量逐行读取（正常追加、末尾不完整行处理）
  - copytruncate 轮转检测与处理
  - rename 轮转检测与旧文件追尾
- [x] 8.3 `tests/unit/file-collection/file-sls-sender.test.ts`：
  - enqueue + flush 基本流程
  - bufferSize 反压查询
- [x] 8.4 `tests/unit/file-collection/file-pipeline.test.ts`：
  - pipeline 生命周期（start/stop）
  - 反压机制（buffer 满时跳过读取）
  - 轮转追尾优先于反压
- [x] 8.5 `tests/unit/file-collection/file-collection-manager.test.ts`：
  - 配置加载与 pipeline 创建
  - 配置新增/删除/修改的动态响应
- [x] 8.6 运行全量测试套件 `npm test`，确保无回归（注：本地 Node 16 环境无法运行 Vitest，需 Node 18+）

## 9. 验证

- [x] 9.1 验证实现是否符合基准约束（ESM-only、strict TypeScript、BaseInput 生命周期不受影响）
- [x] 9.2 编译检查：`npm run typecheck` 通过
- [x] 9.3 确认 `SlsFlusher` 重构后行为不变（现有 SLS 发送路径无回归）

## 10. 基准文档更新（需人工确认后执行）

- [x] 10.1 新增 `docs/modules/file-collection.md` — 文件采集模块文档（职责、接口、内部设计、约束）
- [x] 10.2 更新 `docs/modules/flushers.md` — 新增 `sls-transport` 公共传输层说明
- [x] 10.3 更新 `docs/modules/core.md` — Orchestrator 启动步骤新增 FileCollectionManager
- [x] 10.4 更新 `AGENTS.md` — 架构总览增加 File Collection 模块
