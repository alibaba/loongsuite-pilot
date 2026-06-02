## Context

当前 loongsuite-pilot 的数据管道是 `BaseInput → AgentActivityEntry → InputManager → MultiFlusher → SLS/JSONL/HTTP`。所有 input 共享一个 `MultiFlusher`，所有数据经过 `serialiseLogEntry()` 标准化。

文件采集的需求与此不同：原始日志行，每个配置独立的 SLS 目标，完全隔离的 pipeline。因此设计为与现有管道并行的独立子系统，而非嵌入现有 `BaseInput` 体系。

SLS WebTracking 发送的核心逻辑（HTTP POST、分片、重试、失败持久化）已在 `SlsFlusher` 中实现且经过生产验证。为避免代码重复，将这部分抽取为 `sls-transport` 公共模块。

## Goals / Non-Goals

**Goals:**
- 支持多个采集配置并行运行，每个配置完全隔离（state、flusher、buffer）
- 配置动态加载/卸载（通过文件系统监控配置目录）
- 支持 glob 通配符文件发现
- 支持 rename 和 copytruncate 两种日志轮转模式
- 支持反压：发送慢时暂停读取，不丢数据
- 复用现有 SLS WebTracking 传输代码

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

配置目录：`~/.loongsuite-pilot/file-collection/`

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
| 文件读取 | 独立的 `FileTailer` 实例 |
| 发送 | 独立的 `FileSlsSender` 实例（独立 endpoint） |
| 状态 | 独立的 `StateStore` 实例（`file-collection-state/<configName>.json`） |
| 缓冲 | 独立的有界 buffer |
| 失败日志 | 独立的失败文件（`file-collection-failed/<configName>.jsonl`） |

### D4. 文件发现（glob 匹配）

`FileTailer.discoverFiles()` 逻辑：

1. 对每个 `FilePaths` 配置项执行 glob 匹配
2. `MaxDirSearchDepth` 控制目录递归深度（0 = 仅匹配当前目录）
3. 返回匹配的文件列表，过滤掉目录和符号链接指向的目录
4. 实现方式：使用 `node:fs` + `node:path` 手动实现简单的 glob 匹配（支持 `*` 通配符），避免引入外部依赖

### D5. 增量逐行读取

每个文件的读取策略：

```
readNewLines(filePath, checkpoint):
  1. stat(filePath)
  2. 轮转检测（见 D6）
  3. 计算可读范围：readSize = min(stat.size - offset, MAX_READ_BYTES)
     MAX_READ_BYTES = 4MB（防止单次内存暴涨）
  4. read(fd, offset, readSize)
  5. 找到最后一个 '\n' 的位置
     - 如果没有 '\n' → 整块是不完整行，不推进 offset
     - 否则 → 截取到最后一个 '\n'，split 为完整行
  6. 更新 checkpoint: { offset: newOffset, inode: stat.ino }
  7. return lines
```

### D6. 日志轮转处理

每个文件的 checkpoint 结构：

```typescript
interface FileCheckpoint {
  offset: number;    // 已读取到的字节偏移
  inode: number;     // 上次记录的 inode
}
```

检测与处理逻辑：

| 条件 | 判定 | 处理 |
|------|------|------|
| `stat.ino === checkpoint.inode && stat.size >= offset` | 正常追加 | 从 offset 继续读 |
| `stat.ino === checkpoint.inode && stat.size < offset` | copytruncate 轮转 | offset 归零，从头读 |
| `stat.ino !== checkpoint.inode` | rename 轮转 | 先追尾旧文件，再从新文件头读 |

**rename 轮转的旧文件追尾**：

1. 扫描同目录下所有文件，找到 `inode === checkpoint.inode` 的文件
2. 找到 → 从 `checkpoint.offset` 读到文件末尾，发出这些行
3. 没找到 → 放弃旧文件未读部分（文件已被删除），记录 warn 日志
4. 更新 checkpoint 为新文件的 inode，offset 归零

旧文件追尾的优先级高于反压控制（见 D7），因为旧文件随时可能被 logrotate 删除。

### D7. 反压机制

```
FileTailer → [Buffer (有界)] → FileSlsSender
              ↑ 满了暂停读取     ↑ 定时 flush
```

- **Buffer 容量**：`maxBufferLines`，默认 10000 条
- **HIGH_WATERMARK**：80%（8000 条），达到时暂停新文件读取
- **发送侧**：`flushIntervalMs` 定时（默认 2s）从 buffer 取出一批发送
- **旧文件追尾**：不受反压限制，直接入 buffer（旧文件残留数据通常很少）

poll cycle 逻辑：

```
pollCycle():
  1. 对所有已知文件执行轮转检测
     - 如有 rename 轮转：追尾旧文件 → 入 buffer（不限反压）
  2. if buffer.length >= HIGH_WATERMARK → 跳过正常读取
  3. else → discoverFiles() + readNewLines() → 入 buffer
  4. stateStore.save()
```

### D8. SLS 传输层抽取（sls-transport.ts）

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

### D9. FileSlsSender 数据格式

每条日志行发送到 SLS 的格式：

```json
{
  "content": "2024-06-01 10:00:00 ERROR some error message"
}
```

`__topic__` 设置为 `configName`，`__source__` 设置为本机 IP。

### D10. Orchestrator 集成

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

### D11. 运行时目录布局

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

### D12. 错误处理与容错

| 场景 | 处理方式 |
|------|---------|
| 配置文件 JSON 解析失败 | warn 日志，跳过该配置 |
| 被采集文件不存在 | 静默跳过，等下次 cycle |
| 被采集文件读取权限不足 | warn 日志，跳过该文件 |
| SLS 发送失败（可重试） | 指数退避重试，最多 3 次 |
| SLS 发送失败（不可重试） | 持久化到 `file-collection-failed/<configName>.jsonl` |
| 单个 pipeline 异常 | 不影响其他 pipeline |
| glob 匹配到大量文件 | 单次 cycle 最多处理 100 个文件 |

## Baseline Documentation Sync

本变更新增了 `file-collection` 模块并重构了 `sls-transport` 传输层，需要在实现完成后更新以下基准文档：
- 新增 `docs/modules/file-collection.md`
- 更新 `docs/modules/flushers.md`（新增 sls-transport 说明）
- 更新 `docs/modules/core.md`（Orchestrator 新增步骤）
- 更新 `AGENTS.md`（架构总览图）
