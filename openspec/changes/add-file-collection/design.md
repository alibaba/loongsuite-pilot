## Context

当前 loongsuite-pilot 的数据管道是 `BaseInput → AgentActivityEntry → InputManager → MultiFlusher → SLS/JSONL/HTTP`。所有 input 共享一个 `MultiFlusher`，所有数据经过 `serialiseLogEntry()` 标准化。

文件采集的需求与此不同：原始日志行，每个配置独立的 SLS 目标，完全隔离的 pipeline。因此设计为与现有管道并行的独立子系统，而非嵌入现有 `BaseInput` 体系。

SLS WebTracking 发送的核心逻辑（HTTP POST、分片、重试、失败持久化）已在 `SlsFlusher` 中实现且经过生产验证。为避免代码重复，将这部分抽取为 `sls-transport` 公共模块。

### ilogtail 架构参考

本次重新设计参考了 ilogtail（LoongCollector）C++ 核心引擎的以下关键模式：

1. **事件驱动 + Polling 双层监控**：ilogtail 使用 `inotify`（`EventListener`）实时感知文件变更，`PollingModify` / `PollingDirFile` 线程做定时兜底扫描。事件通过 `EventDispatcher` 分发给对应目录的 `EventHandler`。
2. **三级异步队列解耦**：`Input(ReadLog) → ProcessQueue → ProcessorRunner → SenderQueue → FlusherRunner → HttpSink`，每级之间通过有界队列异步解耦，反压逐级传导。
3. **Reader 队列 + RotatorMap**：`ModifyHandler` 为同一文件名维护 `LogFileReaderPtrArray`（deque），轮转时旧 reader 排在队列前面优先读完。打开失败的 reader 放入 `RotatorReaderMap` 等待重新匹配。
4. **文件签名（Signature）**：不仅用 `DevInode`，还用文件头 N 字节的 hash 做签名，精确检测 copytruncate 类轮转。
5. **时间片控制**：单个文件的 modify 事件处理有 `readFileTimeSlice`（默认 25ms），超时则重新入队下次继续，防止大文件阻塞其他文件读取。
6. **Checkpoint 完备性**：`CheckPoint` 包含 `DevInode`、`Offset`、`SignatureHash/Size`、`Cache`（不完整行缓存）、`LastUpdateTime`、`IdxInReaderArray` 等字段，启动时通过 `AddExistedCheckPointFileEvents()` 为已有 checkpoint 生成 modify 事件驱动恢复。

## Goals / Non-Goals

**Goals:**
- 支持多个采集配置并行运行，每个配置完全隔离（state、flusher、buffer）
- 配置动态加载/卸载（通过文件系统监控配置目录）
- 支持 glob 通配符文件发现
- 支持 rename 和 copytruncate 两种日志轮转模式
- 支持反压：发送慢时暂停读取，不丢数据
- 复用现有 SLS WebTracking 传输代码
- **事件驱动文件监控**：fs.watch 实时感知 + polling 兜底，降低延迟和 CPU 开销
- **读取-发送异步解耦**：读取和发送通过有界队列解耦，互不阻塞
- **Reader 队列**：轮转时旧文件和新文件可并行追踪
- **时间片控制**：防止单个大文件阻塞其他文件读取

**Non-Goals:**
- 不支持 AK 签名模式（本次仅 WebTracking）
- 不支持多行日志聚合
- 不支持日志解析、正则提取、字段映射
- 不支持远程配置下发
- 不支持除 SLS 之外的输出目标

## Decisions

### D1. 并行管道架构（不复用 BaseInput 体系）

文件采集作为与 agent activity 管道并行的独立子系统：

```
Orchestrator
├── agent activity pipeline (existing)
│   └── InputManager → MultiFlusher
└── file collection pipeline (new)
    └── FileCollectionManager → N × FilePipeline
```

原因：
- 数据格式不同（raw lines vs AgentActivityEntry）
- Flusher 模型不同（per-config 独立 vs 共享 MultiFlusher）
- 生命周期不同（动态配置加载 vs 静态注册）

### D2. 配置目录与动态加载

配置目录：`~/.loongsuite-pilot/configs/local/`

每个 `.json` 文件对应一个采集 pipeline。格式采用 iLogtail 风格：

```json
{
  "configName": "sample-file-config",
  "inputs": [{
    "Type": "input_file",
    "FilePaths": ["/work/mnt/test_case/*.log"],
    "FileEncoding": "utf8",
    "MaxDirSearchDepth": 0,
    "AllowingIncludedByMultiConfigs": true
  }],
  "flushers": [{
    "Type": "flusher_sls",
    "Endpoint": "cn-hongkong-intranet.log.aliyuncs.com",
    "Project": "k8s-log-xxx",
    "Logstore": "file-rotate-test",
    "Region": "cn-hongkong",
    "Aliuid": "1654218965343050",
    "TelemetryType": "logs"
  }]
}
```

`FileCollectionManager` 使用 `fs.watch` 监控配置目录变化：
- 文件新增 → `createPipeline(config)`
- 文件删除 → `destroyPipeline(configName)`
- 文件修改 → `destroyPipeline` + `createPipeline`
- 兜底策略：每 60s 全量 rescan，防止 `fs.watch` 丢事件

### D3. Pipeline 隔离模型

每个 `FilePipeline` 拥有独立的：

| 组件 | 隔离方式 |
|------|---------|
| 文件监控 | 独立的 `FileWatcher` 实例（per dir fs.watch） |
| 文件读取 | 独立的 `FileTailer` 实例 |
| 处理队列 | 独立的有界 buffer（读取-发送解耦中枢） |
| 发送 | 独立的 `FileSlsSender` 实例（独立 endpoint、独立消费循环） |
| 状态 | 独立的 `StateStore` 实例（`file-collection-state/<configName>.json`） |
| 失败日志 | 独立的失败文件（`file-collection-failed/<configName>.jsonl`） |

### D4. 文件发现（glob 匹配）

`FileTailer.discoverFiles()` 逻辑：

1. 对每个 `FilePaths` 配置项执行 glob 匹配
2. `MaxDirSearchDepth` 控制目录递归深度（0 = 仅匹配当前目录）
3. 返回匹配的文件列表，过滤掉目录和符号链接指向的目录
4. 实现方式：使用 `node:fs` + `node:path` 手动实现简单的 glob 匹配（支持 `*` 通配符），避免引入外部依赖

### D5. 事件驱动 + Polling 双层文件监控

参考 ilogtail 的 `EventListener` + `PollingModify` 双层架构，实现 **fs.watch 实时感知 + polling 兜底** 的文件监控机制：

```
FileWatcher (fs.watch per parent dir)
  └→ dirtyFiles Set (标记哪些文件有变更)
       └→ pollCycle 优先处理 dirty 文件

PollingDiscovery (兜底，每 30s)
  └→ 发现新文件 / stat 已知文件 → 标记 dirty
```

#### FileWatcher

每个 `FilePipeline` 启动时，对所有 glob pattern 的父目录创建 `fs.watch`：

```typescript
class FileWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private dirtyFiles: Set<string> = new Set();

  watch(dirs: string[]): void;          // 对每个目录创建 fs.watch
  getDirtyFiles(): string[];            // 取出并清空 dirtyFiles
  close(): void;                        // 关闭所有 watcher
}
```

- `fs.watch` 的 `change` 事件 callback 中，将变更文件加入 `dirtyFiles` set（去重）
- `fs.watch` 失败时静默降级到纯 polling 模式
- 仅监听一层目录，不递归（与 MaxDirSearchDepth 解耦）

#### 改造后的 pollCycle

```
pollCycle():
  1. dirtyFiles = fileWatcher.getDirtyFiles()
  2. 合并 dirtyFiles + 已知文件列表 → 需处理文件集合
  3. 对每个文件：轮转检测 + 读取 + 入队列（受时间片控制）
  4. 每 30s 执行一次 discoverFiles() 全量 rescan（兜底）
  5. stateStore.save()
```

- **正常情况**：fs.watch 触发 → dirty → 下个 pollCycle 立即处理，延迟 ≤ pollInterval（1s）
- **降级情况**：fs.watch 不可用时，全量 rescan 间隔从 30s 保障发现新数据
- **CPU 优化**：非 dirty 文件不做 stat/read，只有 dirty 文件和兜底 rescan 时才检查

### D6. 读取-发送异步解耦

参考 ilogtail 的 `ProcessQueue → FlusherRunner` 分离模式，将读取和发送通过 `FileSlsSender` 的内部有界 buffer 解耦：

```
FileTailer.readNewLines()
  → lines
    → FileSlsSender.enqueue()  // 写入有界 buffer
      → FileSlsSender.flushLoop()  // 独立定时消费

反压信号：
  FileSlsSender.bufferSize() >= HIGH_WATERMARK
    → FilePipeline.pollCycle() 跳过正常读取
```

`FileSlsSender` 已有的 `buckets: Map<string, Record<string, string>[]>` 即为有界 buffer，复用不额外抽类。改造点：

- `enqueue()` 时检查 `bufferSize() >= MAX_BUFFER_SIZE`，超出时 **拒绝写入并返回 false**（取代当前的 drop-oldest 行为），让 pollCycle 知道应停止读取
- `flush()` 的消费循环与 `pollCycle()` 完全独立（已通过 `setInterval` 实现）
- 反压恢复：下个 pollCycle 发现 `bufferSize() < HIGH_WATERMARK` 时恢复读取

### D7. 增量逐行读取 + 时间片控制

参考 ilogtail 的 `readFileTimeSlice`，防止单个大文件阻塞整个 poll 周期。

每个文件的读取策略：

```
readNewLines(filePath, checkpoint):
  1. stat(filePath)
  2. 轮转检测（见 D9）
  3. 计算可读范围：readSize = min(stat.size - offset, MAX_READ_BYTES)
     MAX_READ_BYTES = 4MB（防止单次内存暴涨）
  4. read(fd, offset, readSize)
  5. 找到最后一个 '\n' 的位置
     - 如果没有 '\n' → 不完整行存入 checkpoint.cache，不推进 offset
     - 否则 → 截取到最后一个 '\n'，split 为完整行
  6. 更新 checkpoint
  7. return { lines, hasMore: stat.size > newOffset }
```

**时间片控制**（在 `pollCycle` 层面实现）：

```typescript
const READ_TIME_SLICE_MS = 50;

for (const file of files) {
  const start = performance.now();
  let hasMore = true;
  while (hasMore && performance.now() - start < READ_TIME_SLICE_MS) {
    const result = await tailer.readNewLines(file, checkpoint);
    if (result.lines.length > 0) sender.enqueue(result.lines, file);
    checkpoint = result.checkpoint;
    hasMore = result.hasMore;
  }
  if (hasMore) {
    dirtyFiles.add(file);  // 没读完，标记为 dirty，下次 poll 继续
  }
}
```

- 单文件最多占用 50ms 时间片，超时则标记 dirty 下次继续
- `readNewLines` 返回 `hasMore` 标志，表示文件是否还有未读数据

### D8. Reader 队列（轮转文件追踪）

参考 ilogtail 的 `LogFileReaderPtrArray`（deque），实现最简版本的 reader 队列：

```typescript
interface FileReaderState {
  filePath: string;           // 当前文件路径
  devInode: DevInode;         // { dev, ino }
  offset: number;
  signatureHash: string;      // 文件头签名
  lastUpdateTime: number;     // 最后活跃时间
  cache: string;              // 未完成行缓存
  deleted: boolean;           // 文件是否已删除
  deletedTime: number;        // 删除时间（用于超时清理）
}

interface DevInode {
  dev: number;
  ino: number;
}
```

**Reader 队列管理**（在 `FileTailer` 层面）：

```typescript
class FileTailer {
  // 同一文件名 → reader 队列（旧在前，新在后）
  private readerQueues: Map<string, FileReaderState[]> = new Map();
  // devInode → reader 快速查找
  private devInodeMap: Map<string, FileReaderState> = new Map();
}
```

**轮转处理流程**：

| 条件 | 判定 | 处理 |
|------|------|------|
| inode 相同 && size >= offset | 正常追加 | 从 offset 继续读 |
| inode 相同 && size < offset | copytruncate 轮转 | offset 归零，从头读 |
| inode 相同 && signature 变化 | copytruncate 轮转（新内容填充超过 offset） | offset 归零，从头读 |
| inode 不同 | rename 轮转 | 旧 reader 保留在队列前端，新 reader 追加到队列尾部 |

**rename 轮转的处理**：

1. 检测到 inode 变化 → 创建新 reader（inode=新, offset=0）追加到队列尾部
2. 旧 reader 保留在队列前端，继续从旧 offset 读取旧文件（通过 devInode 查找旧文件的当前路径）
3. `pollCycle` 中优先处理队列前端（旧 reader），读完后移除
4. 旧 reader 查找失败（文件已删除）→ warn 日志，移除旧 reader
5. 旧 reader 超时（`READER_TIMEOUT_MS = 600_000`，10 分钟未更新）→ 移除

**简化决策**（相比 ilogtail）：
- 不实现 RotatorReaderMap（打开失败的 reader 直接重试，不做复杂的重匹配）
- Reader 队列最大长度 = 3（超出时丢弃最旧的 reader）
- 不实现 reader 在队列中的位置持久化（重启后从 checkpoint 恢复，旧 reader 自然丢失）

### D9. 增强 Checkpoint

参考 ilogtail 的 `CheckPoint` 结构，增强 checkpoint 的完备性：

```typescript
interface FileCheckpoint {
  offset: number;
  inode: number;
  dev: number;
  signatureHash: string;      // 文件头签名 hash
  signatureSize: number;      // 签名使用的字节数
  lastUpdateTime: number;     // ms timestamp
  cache: string;              // 上次读取的不完整行尾部
}
```

**签名计算优化**：

- 签名 = 文件前 1024 字节的 MD5 hash（与当前一致）
- **不再每次 poll 都计算签名**：仅在以下时机计算：
  1. 首次发现文件（新建 reader 时）
  2. 检测到 `size < offset`（疑似 copytruncate）
  3. 检测到 `inode 变化`（疑似 rename）
- 正常追加读取时，仅用 `inode + offset` 判断，不做签名检查

**不完整行缓存（cache）**：

```
readNewLines():
  ...
  5. 找到最后一个 '\n' 的位置
     - 如果整块都没有 '\n'：
       checkpoint.cache += text;  // 追加到缓存
       不推进 offset（等下次读取更多数据）
     - 否则：
       completePart = checkpoint.cache + text.substring(0, lastNewline)
       checkpoint.cache = ''  // 清空缓存
       lines = completePart.split('\n').filter(l => l.length > 0)
       推进 offset
```

- `cache` 会持久化到 state file，重启后继续拼接
- `cache` 有大小上限（`MAX_CACHE_BYTES = 1MB`），超出时丢弃并 warn

**Checkpoint 持久化时机**：
- 每个 `pollCycle` 结束时批量 save（不是每个文件读取后）
- `stop()` 时强制 save

### D10. SLS 传输层抽取（sls-transport.ts）

从 `SlsFlusher` 抽取以下公共逻辑到 `src/flushers/sls-transport.ts`：

```typescript
// 公共接口
interface SlsTransportConfig {
  endpoint: string;      // SLS endpoint URL
  project: string;
  logstore: string;
  timeoutMs?: number;    // 默认 10s
  maxRetries?: number;   // 默认 3
  retryBaseDelayMs?: number; // 默认 1000ms
}

// 公共方法
function postWebtracking(config, logs: Record<string, string>[]): Promise<void>
function splitForWebtracking(logs, maxLogs, maxBytes): Record<string, string>[][]
function isRetryable(err: unknown): boolean
function persistFailedLogs(dir, name, logGroup, err): Promise<void>
```

`SlsFlusher` 改为调用 `sls-transport` 中的公共方法，行为不变。
`FileSlsSender` 同样调用 `sls-transport`，但发送格式不同：

```
SlsFlusher:      serialiseLogEntry(entry) → KV Record → postWebtracking()
FileSlsSender:   line → { content: line } → postWebtracking()
```

### D11. FileSlsSender 数据格式与反压改造

每条日志行发送到 SLS 的格式：

```json
{
  "content": "2024-06-01 10:00:00 ERROR some error message"
}
```

`__topic__` 设置为 `configName`，`__source__` 设置为本机 IP。

**反压改造**：

```
FileTailer → FileSlsSender.enqueue() → [有界 buffer] → FileSlsSender.flushLoop()
              ↑ 返回 false 表示满了                     ↑ 独立 setInterval 消费
```

- **Buffer 容量**：`MAX_BUFFER_SIZE = 500_000` 条
- **HIGH_WATERMARK**：80%（400_000 条），达到时 pollCycle 跳过正常读取
- **enqueue 行为改变**：满时返回 false（不再 drop-oldest），由 pollCycle 决定是否继续读
- **旧文件追尾**：不受反压限制，直接 enqueue（旧文件残留数据通常很少）

### D12. Orchestrator 集成

`Orchestrator.start()` 新增步骤 11：

```typescript
// 11. Start file collection pipelines
this.fileCollectionManager = new FileCollectionManager({
  configDir: path.join(this.dataDir, 'file-collection'),
  stateDir: path.join(this.dataDir, 'logs', 'file-collection-state'),
  failedLogDir: path.join(this.dataDir, 'logs', 'file-collection-failed'),
});
await this.fileCollectionManager.start();
```

`Orchestrator.stop()` 中对应增加 `this.fileCollectionManager?.stop()`。

### D13. 运行时目录布局

```
~/.loongsuite-pilot/
├── file-collection/                          ← 配置目录（用户管理）
│   ├── sample-file-config.json
│   └── nginx-access.json
├── logs/
│   ├── file-collection-state/                ← 每配置独立状态
│   │   ├── sample-file-config.json
│   │   └── nginx-access.json
│   └── file-collection-failed/               ← 每配置独立失败日志
│       ├── sample-file-config.jsonl
│       └── nginx-access.jsonl
└── ...
```

### D14. 错误处理与容错

| 场景 | 处理方式 |
|------|---------|
| 配置文件 JSON 解析失败 | warn 日志，跳过该配置 |
| 被采集文件不存在 | 静默跳过，等下次 cycle |
| 被采集文件读取权限不足 | warn 日志，跳过该文件 |
| fs.watch 创建失败 | warn 日志，降级到纯 polling |
| fs.watch 运行中出错 | 关闭该 watcher，降级到纯 polling |
| SLS 发送失败（可重试） | 指数退避重试，最多 3 次 |
| SLS 发送失败（不可重试） | 持久化到 `file-collection-failed/<configName>.jsonl` |
| 单个 pipeline 异常 | 不影响其他 pipeline |
| glob 匹配到大量文件 | 单次 cycle 最多处理 100 个文件 |
| 单文件读取超时间片 | 标记 dirty，下次 pollCycle 继续 |
| Reader 队列溢出 | 丢弃最旧的 reader（最大长度 3） |
| 不完整行缓存超限 | cache > 1MB 时丢弃并 warn |
| 旧 reader 超时 | 10 分钟未更新自动清理 |

### D15. 整体数据流

```
                                    ┌──────────────────────────────────────────────────────┐
                                    │              FilePipeline (per config)                │
                                    │                                                      │
  fs.watch(dir)──→ dirtyFiles Set ──┤                                                      │
                                    │  pollCycle():                                        │
  Polling (30s) ──→ discoverFiles()─┤    for file in (dirty ∪ rescan):                     │
                                    │      ┌─────────────────────────────┐                  │
                                    │      │ time-slice loop (50ms max) │                  │
                                    │      │   readNewLines(file, cpt)  │                  │
                                    │      │   → lines, hasMore, cpt   │                  │
                                    │      └──────────┬──────────────────┘                  │
                                    │                 │                                    │
                                    │                 ▼                                    │
                                    │       enqueue(lines) ──→ [有界 buffer]               │
                                    │         ↑ backpressure     │                         │
                                    │         │                  ▼                         │
                                    │       if full: skip     flushLoop() (2s interval)    │
                                    │                           │                         │
                                    │                           ▼                         │
                                    │                    postWebtracking()                  │
                                    │                           │                         │
                                    │                    ┌──────┴──────┐                    │
                                    │                    │             │                    │
                                    │                 success      failure                  │
                                    │                    │        persistFailedLogs()       │
                                    └──────────────────────────────────────────────────────┘
```

## Baseline Documentation Sync

本变更新增了 `file-collection` 模块并重构了 `sls-transport` 传输层，需要在实现完成后更新以下基准文档：
- 新增 `docs/modules/file-collection.md`
- 更新 `docs/modules/flushers.md`（新增 sls-transport 说明）
- 更新 `docs/modules/core.md`（Orchestrator 新增步骤）
- 更新 `AGENTS.md`（架构总览图）
