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

## 2. 文件采集类型定义（增强版）

- [ ] 2.1 更新 `src/file-collection/types.ts`，增强以下类型：
  - `DevInode`：`{ dev: number; ino: number }`
  - `FileCheckpoint` 增强：增加 `dev`, `signatureHash`, `signatureSize`, `lastUpdateTime`, `cache` 字段
  - `FileReaderState`：`filePath`, `devInode: DevInode`, `offset`, `signatureHash`, `lastUpdateTime`, `cache`, `deleted`, `deletedTime`
  - `ReadResult` 增强：增加 `hasMore: boolean` 字段
  - 其他已有类型保持不变

## 3. FileWatcher — 事件驱动文件监控

- [ ] 3.1 创建 `src/file-collection/file-watcher.ts`
- [ ] 3.2 实现 `FileWatcher` 类：
  - `watch(dirs: string[]): void` — 对每个目录创建 `fs.watch`，change 事件中将变更文件加入 `dirtyFiles` set
  - `getDirtyFiles(): string[]` — 取出并清空 dirtyFiles set
  - `addDirty(filePath: string): void` — 外部手动标记 dirty（供 polling 兜底使用）
  - `close(): void` — 关闭所有 watcher
- [ ] 3.3 fs.watch 错误处理：创建失败或运行中出错时静默降级（warn 日志，不影响 polling 兜底）
- [ ] 3.4 从 glob pattern 列表提取需要监听的父目录去重列表

## 4. FileTailer — 增强文件读取（Reader 队列 + 签名优化）

- [ ] 4.1 更新 `src/file-collection/file-tailer.ts`，增加 Reader 队列管理：
  - `readerQueues: Map<string, FileReaderState[]>` — 同一文件名的 reader 队列（旧在前，新在后）
  - `devInodeMap: Map<string, FileReaderState>` — devInode→reader 快速查找
  - `initReaderFromCheckpoint(filePath, checkpoint)` — 从 checkpoint 恢复 reader
  - `cleanupStaleReaders()` — 清理超时旧 reader（10 分钟未更新）
- [ ] 4.2 重构 `readNewLines()` 返回值增加 `hasMore: boolean`
  - 当 `stat.size > newOffset` 时 `hasMore = true`，告知调用方还有数据可读
- [ ] 4.3 优化签名计算策略：
  - 仅在首次发现文件、`size < offset`、`inode 变化` 时计算签名
  - 正常追加读取时不做签名检查
- [ ] 4.4 实现不完整行缓存（cache）：
  - 读取时若整块无 `\n`，追加到 `checkpoint.cache`
  - 下次读取时，将 cache 前缀拼接到新数据
  - cache 大小上限 `MAX_CACHE_BYTES = 1MB`，超出时丢弃并 warn
- [ ] 4.5 轮转处理增强（Reader 队列版本）：
  - rename 轮转：创建新 reader 追加到队列尾部，旧 reader 保留在前端继续读完
  - copytruncate 轮转：相同 inode，通过 `size < offset` 或 signature 变化检测
  - reader 队列最大长度 = 3，超出时丢弃最旧
- [ ] 4.6 `getActiveFiles(): string[]` — 返回当前有活跃 reader 的文件列表（供 pollCycle 使用）
- [ ] 4.7 `processReaderQueue(fileName): ReadResult` — 优先处理队列前端旧 reader，读完后移除

## 5. FileSlsSender — 反压改造

- [ ] 5.1 更新 `src/file-collection/file-sls-sender.ts`：
  - `enqueue()` 返回 `boolean`：buffer 满时返回 `false`（取代 drop-oldest）
  - 增加 `isBackpressured(): boolean` — 返回 `bufferSize() >= HIGH_WATERMARK`
- [ ] 5.2 保持 `flushLoop()` 独立 setInterval 消费，与 pollCycle 完全解耦
- [ ] 5.3 `HIGH_WATERMARK` = 400_000（MAX_BUFFER_SIZE 的 80%）

## 6. FilePipeline — 整合事件驱动 + 时间片控制

- [ ] 6.1 更新 `src/file-collection/file-pipeline.ts`，整合 FileWatcher：
  - 构造函数中创建 `FileWatcher` 实例
  - `start()` 时从 glob pattern 提取父目录，调用 `fileWatcher.watch(dirs)`
  - `stop()` 时调用 `fileWatcher.close()`
- [ ] 6.2 重写 `pollCycle()` 引入事件驱动 + 时间片：
  - 步骤 1：`dirtyFiles = fileWatcher.getDirtyFiles()`
  - 步骤 2：合并 dirty 文件 + 已知 reader 的活跃文件列表
  - 步骤 3：每 `RESCAN_INTERVAL`（30s）执行一次 `discoverFiles()` 全量 rescan
  - 步骤 4：对每个文件执行时间片读取循环（50ms max per file）
    - `while (hasMore && elapsed < READ_TIME_SLICE_MS)`
    - 如果 `sender.isBackpressured()`：跳过正常读取（旧文件追尾不受限）
    - 如果时间片耗尽但 hasMore：标记为 dirty，下次继续
  - 步骤 5：`tailer.cleanupStaleReaders()` 清理超时 reader
  - 步骤 6：`stateStore.save()` 批量持久化 checkpoint
- [ ] 6.3 `loadCheckpoints()` / `saveCheckpoints()` 适配增强后的 `FileCheckpoint` 结构

## 7. FileCollectionManager — 配置目录管理（无变更）

已实现，保持不变。

## 8. Orchestrator 集成（无变更）

已实现，保持不变。

## 9. 测试

- [ ] 9.1 `tests/unit/file-collection/file-watcher.test.ts`（新增）：
  - fs.watch 触发时正确标记 dirtyFiles
  - getDirtyFiles() 取出后清空
  - fs.watch 失败时静默降级
  - 多个目录监听去重
- [ ] 9.2 更新 `tests/unit/file-collection/file-tailer.test.ts`：
  - Reader 队列：rename 轮转时旧 reader 排在前面优先读
  - Reader 队列溢出（长度 > 3）时丢弃最旧
  - 签名优化：正常追加时不计算签名
  - 不完整行缓存：跨 read 拼接、cache 超限丢弃
  - readNewLines 返回 hasMore
  - 超时 reader 清理
- [ ] 9.3 更新 `tests/unit/file-collection/file-sls-sender.test.ts`：
  - enqueue 满时返回 false
  - isBackpressured() 水位检查
- [ ] 9.4 更新 `tests/unit/file-collection/file-pipeline.test.ts`：
  - 事件驱动：dirty 文件优先处理
  - 时间片控制：大文件不阻塞其他文件
  - 反压：sender 满时跳过读取
  - 兜底 rescan 定期执行
- [ ] 9.5 运行全量测试套件 `npm test`，确保无回归

## 10. 验证

- [ ] 10.1 验证实现是否符合基准约束（ESM-only、strict TypeScript、BaseInput 生命周期不受影响）
- [ ] 10.2 编译检查：`npm run typecheck` 通过
- [ ] 10.3 确认 `SlsFlusher` 重构后行为不变（现有 SLS 发送路径无回归）

## 11. 基准文档更新（需人工确认后执行）

- [ ] 11.1 新增 `docs/modules/file-collection.md` — 文件采集模块文档（职责、接口、内部设计、约束）
- [ ] 11.2 更新 `docs/modules/flushers.md` — 新增 `sls-transport` 公共传输层说明
- [ ] 11.3 更新 `docs/modules/core.md` — Orchestrator 启动步骤新增 FileCollectionManager
- [ ] 11.4 更新 `AGENTS.md` — 架构总览增加 File Collection 模块
