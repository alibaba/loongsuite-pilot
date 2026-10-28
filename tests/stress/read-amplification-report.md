# Issue #720491 — Codex Transcript 读放大问题分析与压测报告

## 1. 问题概述

`CodexTranscriptInput` 在轮询采集 Codex 转录文件（JSONL）时，存在 5 条独立的读放大路径。这些路径在特定文件/状态条件下，导致每个 poll 周期对同一文件范围进行重复磁盘读取，产生大量无效 I/O 和 CPU 消耗，且不产出任何新遥测条目。

**影响**：生产环境中持续高 CPU 使用率、I/O 压力增大，严重时可影响采集延迟和系统整体性能。

**测试环境**：darwin/arm64, Node v24.18.0, Apple M5 Pro (15 cores)
**代码版本**：main branch, commit 2e98f307
**源文件**：`src/inputs/codex-transcript/codex-transcript-input.ts` (3515 lines)

---

## 2. 压测结论总览

100 轮 poll 周期，5 条路径合计：

| 指标 | 数值 |
|------|------|
| **总 I/O 读取** | **10.39 GiB** |
| **总 CPU 耗时** | **15.54 秒** |
| **新遥测条目** | **0** |

| 路径 | 触发条件 | 平均读取/轮 | 平均 CPU/轮 | 放大倍数 |
|------|----------|-------------|-------------|----------|
| A | 单条记录 >16 MiB（fork 转录） | 15.84 MiB | 27.79 ms | **79.2x** |
| B | 活跃 turn 未关闭且文件持续增长 | 49.27 MiB | 34.29 ms | **1029.9x** |
| C | 转录文件缺少 `session_meta` 记录 | 4.72 MiB | 10.36 ms | **198.0x** |
| D | 终端 turn 解析持续失败 | 4.73 MiB | 3.53 ms | **99.0x** |
| E | 元数据缓存容量不足 | 31.85 MiB | 79.38 ms | **33.0x** |

> **放大倍数** = 100 轮总 I/O 读取量 / 文件初始大小

---

## 3. 逐路径根因分析

### 3.1 Path A — `findTurnStartOffset` 卡死在超大 JSON 行

**问题定位**：`codex-transcript-input.ts` line 2777

**触发条件**：Fork（子代理）转录文件中，存在一条超过 16 MiB 的 JSON 记录（如包含大文件内容的 `function_call_output`）。

**根因**：

`findTurnStartOffset` 调用 `scanJsonLines` 扫描 fork 转录以定位拥有者 turn 的起始偏移。扫描预算上限为 `MAX_SCAN_BYTES_PER_FILE_CYCLE`（16 MiB，line 61）：

```typescript
// line 2794-2797
const safeStart = boundedSearchOffset(startOffset, fileSize);
const scanEnd = Math.min(fileSize, safeStart + MAX_SCAN_BYTES_PER_FILE_CYCLE);
await scanJsonLines(filePath, safeStart, scanEnd, line => { ... }, runtime);
```

当单条 JSON 行超过 16 MiB 时，`scanJsonLines` 将全部预算读入缓冲但找不到换行符，`nextOffset` 保持在 `safeStart` 不前进。函数返回后，下一轮 poll 从同一位置重新开始——**永远卡在同一个超大行**。

**对比**：主扫描循环（line 677-690）对这种情况有明确的回退逻辑：

```typescript
// line 677-683 — 主扫描循环的超大行回退
if (scan.nextOffset === scanStartOffset && scanEndOffset < stat.size) {
  scan = await scanJsonLines(
    filePath, scanStartOffset, stat.size,  // 放宽到文件末尾
    line => { processScannedLine(line); return false; },
    runtime,
  );
}
```

但 `findTurnStartOffset` **缺失这个回退**。

**压测数据**：
- 文件大小：20.00 MiB（含一条 20 MiB 的 `function_call_output`）
- 每轮读取：16.00 MiB（恒定，等于 `MAX_SCAN_BYTES_PER_FILE_CYCLE`）
- 100 轮总 I/O：1.55 GiB

---

### 3.2 Path B — 活跃 turn 尾部反复重读（线性恶化）

**问题定位**：`codex-transcript-input.ts` line 723（调用处）, line 816-839（`recoverTurnSegment` 定义）

**触发条件**：一个 turn 处于活跃状态（未收到 `task_complete`），且文件持续增长（Codex 代理正在工作、追加工具调用和输出）。

**根因**：

主扫描循环中，发现活跃 turn 没有终端事件时调用 `recoverTurnSegment`：

```typescript
// line 723-728
const recovered = await this.recoverTurnSegment(
  filePath, checkpoint, nextScanOffset, terminalTurnId !== null,
);
```

`recoverTurnSegment` 的读取范围是 `[activeTurn.startOffset, endOffset)`：

```typescript
// line 834-837
const records = await readJsonLines(
  filePath, activeTurn.startOffset, endOffset, runtime,
);
```

`activeTurn.startOffset` 仅在恢复成功时前进（line 730-735）：

```typescript
// line 730-735
if (recovered.kind !== 'unparseable'
    && recovered.consumedEndOffset > checkpoint.activeTurn.startOffset) {
  checkpoint.activeTurn.startOffset = recovered.consumedEndOffset;
}
```

对于未关闭的 turn，`startOffset` 停留在 turn 起始位置附近。随着文件增长，每轮 poll 从 turn 起始位置重读到当前文件末尾——**读取量与文件大小成线性关系**。

**压测数据**：
- 初始文件：4.78 MiB
- 每轮追加：~0.96 MiB（10 个工具调用对）
- 第 100 轮单次读取：96.63 MiB
- 100 轮总 I/O：4.81 GiB
- **放大倍数：1029.9x**（5 条路径中最严重）

**趋势**：

```
Cycle 1  →   1.91 MiB
Cycle 50 →  ~48    MiB
Cycle 100→  96.63  MiB  ← 线性增长
```

---

### 3.3 Path C — 缺失 `session_meta` 导致全文件扫描

**问题定位**：`codex-transcript-input.ts` line 2754（`findOwnerSessionMetaOffset`）, line 524（调用处）

**触发条件**：转录文件中不包含 `session_meta` 记录（损坏文件、手工创建的文件、或某些边缘场景）。

**根因**：

`scanRolloutFile` 在每轮 poll 中检查 `ownerSessionMetaOffset`：

```typescript
// line 524-531
if (checkpoint.ownerSessionMetaOffset === null) {
  checkpoint.ownerSessionMetaOffset = await findOwnerSessionMetaOffset(
    filePath, stat.size, runtime,
  );
  checkpointChanged = true;
}
```

`findOwnerSessionMetaOffset`（line 2754）从偏移 0 扫描到文件末尾：

```typescript
// line 2754-2761
async function findOwnerSessionMetaOffset(
  filePath: string, endOffset: number, ...
): Promise<number | null> {
  let ownerOffset: number | null = null;
  await scanJsonLines(filePath, 0, endOffset, line => { ... }, runtime);
  return ownerOffset;
}
```

当文件中没有 `session_meta` 时，返回 `null`。`null` 被存入 `checkpoint.ownerSessionMetaOffset`。下一轮 poll，`=== null` 检查再次通过，**触发又一次从 0 到 EOF 的全文件扫描**。

**核心缺陷**：没有使用哨兵值（如 `-1`）来表示"已确认不存在"，导致 `null` 既代表"未检查"也代表"不存在"。

同样的问题出现在 `indexDiscoveredTranscriptOwners`（line 1159）：

```typescript
// line 1159-1160
const ownerOffset = checkpoint?.inode === stat.ino
  ? checkpoint.ownerSessionMetaOffset ?? await findOwnerSessionMetaOffset(...)
```

`??` 运算符让 `null` 每次都 fallthrough 到 `findOwnerSessionMetaOffset`。

**压测数据**：
- 文件大小：2.38 MiB（10,000 条无 `session_meta` 的记录）
- 每轮读取：4.77 MiB（约 2 倍文件大小，含扫描 + 重读）
- 100 轮总 I/O：471.86 MiB

---

### 3.4 Path D — `recoverPendingTerminal` 无限重试

**问题定位**：`codex-transcript-input.ts` line 779-807

**触发条件**：存在一个 `pendingTerminal` 条目，且对应 turn 范围内的数据始终无法被正确解析（如部分损坏的 JSON、写入中断导致的不完整数据）。

**根因**：

当 `recoverTurnSegment` 返回 `'unparseable'` 时，重试逻辑：

```typescript
// line 790-807
if (recovered.kind === 'unparseable') {
  const now = Date.now();
  checkpoint.pendingTerminal = {
    ...pending,
    retryCount: (pending.retryCount ?? 0) + 1,   // 只递增计数
    firstPendingAtMs: pending.firstPendingAtMs ?? now,
    lastAttemptAtMs: now,                          // 记录但从不检查
    sourceRecordCount: recovered.diagnostics.sourceRecordCount,
  };
  this.logger.warn('pending Codex terminal turn still could not be parsed; will retry', ...);
  return { blocked: true, emittedCount: 0, processedTerminalCount: 0 };
}
```

**三个缺失的保护机制**：

1. **无最大重试上限**：`retryCount` 只递增，永远不会触发放弃逻辑
2. **无退避延迟**：`lastAttemptAtMs` 被记录但 `recoverPendingTerminal`（line 607）每轮无条件调用，不检查距上次尝试是否有足够间隔
3. **无文件变更门控**：不检查 `stat.size` 或 `stat.mtimeMs` 是否变化——即使文件完全没有被修改，也会重读相同的字节范围

**压测数据**：
- 文件大小：4.77 MiB
- 每轮读取：4.77 MiB（恒定，完全相同的范围）
- 100 轮总 I/O：472.57 MiB
- 日志证据：`retryCount: 1, 2, 3, ... 100`（无上限）

---

### 3.5 Path E — 元数据缓存溢出导致周期性冷读

**问题定位**：`codex-transcript-input.ts` line 1219-1241（缓存写入逻辑）, line 1133（`indexDiscoveredTranscriptOwners`）

**缓存容量限制**：
- `MAX_LINK_DESCRIPTORS = 10,000` 条目（`codex-subagent-linker.ts` line 78）
- `MAX_CACHED_TRANSCRIPT_META_BYTES = 64 MiB`（line 71）

**触发条件**：发现的转录文件数量（或其元数据总大小）超过缓存容量。

**根因**：

`rememberTranscriptOwnerMeta`（line 1219）在缓存满时静默拒绝 `discovery` 模式的条目：

```typescript
// line 1233-1241
if (
  cacheAccess === 'discovery'
  && (
    this.transcriptMetaCacheByPath.size >= this.transcriptMetaCacheMaxEntries
    || this.transcriptMetaCacheBytes + estimatedBytes > this.transcriptMetaCacheMaxBytes
  )
) {
  return;  // 静默丢弃，不缓存
}
```

`indexDiscoveredTranscriptOwners`（line 1133）在每轮 `collect()` 中调用，以 `'discovery'` 模式（line 1177）加载所有发现文件的元数据：

```typescript
// line 1171-1178
const meta = await this.loadTranscriptOwnerMeta(
  filePath, stat.ino, stat.size, ownerOffset,
  this.getInputRuntimeAccumulator(),
  'discovery',   // ← discovery 模式
);
```

当缓存已满时：
1. `loadTranscriptOwnerMeta` 检查缓存未命中（line 1192-1201）
2. 调用 `readJsonLineAt` 从磁盘读取 `session_meta` 头部（line 1205）
3. 调用 `rememberTranscriptOwnerMeta` 试图缓存——被拒绝
4. 下轮 poll 重复 2-3 步

**被拒绝文件**的 `session_meta` 每轮都要从磁盘重读。`readJsonLineAt` 每次读取 64 KiB 块直到找到换行符，对于大的 `session_meta`（如含长 `base_instructions`），可能需要多个块。

**压测数据**：
- 文件数：500，总大小 96.50 MiB
- 缓存可容纳 ~320 个条目（64 MiB / ~200 KB per entry）
- ~180 个文件每轮被拒绝并重新读取
- 每轮读取：31.85 MiB（恒定）
- 100 轮总 I/O：3.11 GiB

---

## 4. 修复建议

### 4.1 Path A — 为 `findTurnStartOffset` 添加超大行回退

参照主扫描循环（line 677-690）的模式：当 `nextOffset === safeStart` 时，将 `scanEnd` 放宽到文件末尾以跳过超大行。

### 4.2 Path B — 限制未关闭 turn 的重读范围

方案选项：
- 对已 emit 过的记录前移 `startOffset`（增量重读而非全量重读）
- 设置单次 recovery 的最大回溯字节数
- 仅在 `stat.size` 或 `stat.mtimeMs` 变化时重新触发 recovery

### 4.3 Path C — 区分"未检查"和"已确认不存在"

使用哨兵值（如 `-1`）表示"已扫描完整文件，确认无 `session_meta`"：

```typescript
// 建议修改
if (checkpoint.ownerSessionMetaOffset === null) {        // null = 未检查
  // 扫描 ...
} else if (checkpoint.ownerSessionMetaOffset === -1) {   // -1 = 已确认不存在
  // 跳过，不再重复扫描
}
```

### 4.4 Path D — 添加退避/上限/变更门控

- **最大重试次数**：超过阈值后放弃 pendingTerminal（清除并记录警告）
- **指数退避**：基于 `lastAttemptAtMs` 计算下次重试时间
- **文件变更门控**：仅在 `stat.size` 或 `stat.mtimeMs` 变化时重试

### 4.5 Path E — 改进缓存淘汰策略

方案选项：
- LRU 淘汰：discovery 条目可以驱逐最久未访问的条目
- 二级缓存：对被拒绝的条目使用轻量摘要缓存（仅存 threadId，不存 baseInstructions 等大字段）
- 按需索引：仅对 `scanRolloutFile` 实际需要的文件加载元数据，而非每轮全量索引

---

## 5. 压测详细数据

### 5.1 Path A — 逐轮指标

| 指标 | 值 |
|------|------|
| 文件大小 | 20.00 MiB |
| 总 I/O (100 轮) | 1.55 GiB |
| 平均 I/O/轮 | 15.84 MiB |
| 平均 CPU/轮 | 27.79 ms |
| 放大倍数 | 79.2x |

```
cycle │ wall ms  │ cpu ms   │ read
──────┼──────────┼──────────┼──────────────
    1 │      0.6 │      0.4 │  0 B
    2 │     19.9 │     39.1 │  16.00 MiB
    3 │     12.1 │     26.2 │  16.00 MiB
  ... │   ...    │   ...    │  ...
  100 │     12.1 │     31.8 │  16.00 MiB
```

**特征**：恒定 16 MiB/轮，无退化，无进展。

### 5.2 Path B — 逐轮指标

| 指标 | 值 |
|------|------|
| 初始文件大小 | 4.78 MiB |
| 总 I/O (100 轮) | 4.81 GiB |
| 平均 I/O/轮 | 49.27 MiB |
| 平均 CPU/轮 | 34.29 ms |
| 放大倍数 | **1029.9x** |

```
cycle │ wall ms  │ cpu ms   │ read
──────┼──────────┼──────────┼──────────────
    1 │      3.4 │      3.6 │   1.91 MiB
    5 │      4.0 │      3.9 │   5.74 MiB
   50 │     26.0 │     28.0 │  ~48   MiB
   96 │     48.6 │     53.4 │  92.80 MiB
  100 │     57.2 │     59.4 │  96.63 MiB
```

**特征**：线性增长，第 100 轮单次读取接近 100 MiB。**最严重的路径**。

### 5.3 Path C — 逐轮指标

| 指标 | 值 |
|------|------|
| 文件大小 | 2.38 MiB |
| 总 I/O (100 轮) | 471.86 MiB |
| 平均 I/O/轮 | 4.72 MiB |
| 平均 CPU/轮 | 10.36 ms |
| 放大倍数 | 198.0x |

```
cycle │ wall ms  │ cpu ms   │ read
──────┼──────────┼──────────┼──────────────
    1 │      0.2 │      0.2 │  0 B
    2 │     13.6 │     17.9 │  4.77 MiB
  ... │   ...    │   ...    │  ...
  100 │      9.9 │      9.8 │  4.77 MiB
```

**特征**：恒定 ~4.77 MiB/轮，每轮全文件扫描。

### 5.4 Path D — 逐轮指标

| 指标 | 值 |
|------|------|
| 文件大小 | 4.77 MiB |
| 总 I/O (100 轮) | 472.57 MiB |
| 平均 I/O/轮 | 4.73 MiB |
| 平均 CPU/轮 | 3.53 ms |
| 放大倍数 | 99.0x |

```
cycle │ wall ms  │ cpu ms   │ read
──────┼──────────┼──────────┼──────────────
    1 │      0.2 │      0.2 │  0 B
    2 │      2.6 │      2.6 │  4.77 MiB
  ... │   ...    │   ...    │  ...
  100 │      2.5 │      2.4 │  4.77 MiB
```

**特征**：恒定 ~4.77 MiB/轮，完全相同的字节范围被反复读取。

### 5.5 Path E — 逐轮指标

| 指标 | 值 |
|------|------|
| 文件数 | 500 |
| 总磁盘大小 | 96.50 MiB |
| 总 I/O (100 轮) | 3.11 GiB |
| 平均 I/O/轮 | 31.85 MiB |
| 平均 CPU/轮 | 79.38 ms |
| 放大倍数 | 33.0x |

```
cycle │ wall ms  │ cpu ms   │ read
──────┼──────────┼──────────┼──────────────
    1 │     78.5 │     78.5 │  31.85 MiB
    5 │     74.1 │     76.3 │  31.85 MiB
  ... │   ...    │   ...    │  ...
  100 │     79.2 │     74.7 │  31.85 MiB
```

**特征**：恒定 31.85 MiB/轮，~180 个文件的 session_meta 头部每轮从磁盘重读。

---

## 6. 复现方式

```bash
# 压测脚本位置
tests/stress/read-amplification-stress.ts

# 运行全部 5 条路径（100 轮）
npx tsx tests/stress/read-amplification-stress.ts --cycles 100

# 运行单条路径
npx tsx tests/stress/read-amplification-stress.ts --cycles 100 --paths A

# 运行多条路径
npx tsx tests/stress/read-amplification-stress.ts --cycles 50 --paths B,C,D
```

---

## 7. 关键代码位置索引

| 路径 | 函数/位置 | 行号 |
|------|----------|------|
| A | `findTurnStartOffset` | line 2777 |
| A | 主扫描循环超大行回退（对比参照） | line 677-690 |
| A | `MAX_SCAN_BYTES_PER_FILE_CYCLE` | line 61 |
| B | `recoverTurnSegment` 调用处 | line 723 |
| B | `recoverTurnSegment` 定义 | line 816 |
| B | `activeTurn.startOffset` 前进条件 | line 730-735 |
| B | `readJsonLines` 读取范围 | line 834-837 |
| C | `findOwnerSessionMetaOffset` | line 2754 |
| C | null 检查触发重扫 | line 524-531 |
| C | `indexDiscoveredTranscriptOwners` 中的 `??` | line 1159-1160 |
| D | `recoverPendingTerminal` | line 779 |
| D | 重试逻辑（无上限/无退避/无变更门控） | line 790-807 |
| D | 无条件调用入口 | line 607 |
| E | `rememberTranscriptOwnerMeta` 缓存拒绝 | line 1233-1241 |
| E | `loadTranscriptOwnerMeta` 磁盘读取 | line 1205 |
| E | `indexDiscoveredTranscriptOwners` discovery 模式 | line 1171-1178 |
| E | `MAX_CACHED_TRANSCRIPT_META_BYTES` | line 71 |
| E | `MAX_LINK_DESCRIPTORS` | codex-subagent-linker.ts line 78 |
