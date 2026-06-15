# Module: inputs

> Last verified: 2026-06-15

## 职责 (Responsibility)

数据采集层，通过多种策略从 AI coding agents 的本地存储中增量提取活动数据并发射标准化 entries。

## 公共接口 (Public Interface)

- **BaseInput** — 所有 Input 的抽象基类，定义了统一的生命周期（start/stop）、标识信息（id、agentType、collectionMethod）和数据发射机制。继承 EventEmitter，通过 entries 事件输出采集结果。
- **BaseIdeInput** — IDE 本地文件快照轮询策略的基类，子类需实现历史条目扫描和单条目构建逻辑，配合 SnapshotStore 实现去重。
- **BaseSqliteInput** — SQLite rowid 游标增量查询策略的基类，子类需实现新行读取和行转换逻辑。
- **BaseHookInput** — Hook JSONL 日志字节偏移增量读取策略的基类，子类需实现原始记录到标准 entry 的转换。
- **BaseSessionInput** — Session 文件轮询策略的基类，支持 inode rotation 检测，子类需实现文件发现和行解析逻辑。
- **BaseCliForwarder** — CLI 遥测日志转发策略的基类，子类需实现事件过滤和 payload 转换逻辑。

## 不负责 (NOT Responsible For)

- 数据标准化或转换 → normalization 模块负责
- 数据输出/刷新 → flushers 模块负责
- 配置加载与解析 → core 模块 (config-loader) 负责
- Hook 脚本安装 → hooks 模块负责
- 状态存储的序列化格式 → checkpoints 模块负责

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/inputs/
├── base/
│   ├── base-input.ts
│   ├── base-ide-input.ts
│   ├── base-sqlite-input.ts
│   ├── base-hook-input.ts
│   ├── base-session-input.ts
│   └── base-cli-forwarder.ts
├── qoder/                  # IDE snapshot polling
├── qoder-sqlite/           # SQLite token usage polling
├── qoder-cli/              # Hook JSONL input
├── qoder-cli-session/      # Native session file polling
├── qoder-work/             # Hook JSONL input (parameterized: QoderWork + QoderWork CN)
├── qoder-work-log/         # SDK log tail (parameterized: QoderWork + QoderWork CN)
├── qoder-work-sqlite/      # SQLite agents.db (parameterized: QoderWork + QoderWork CN)
├── cursor-hook/            # Cursor hook history input
├── claude-code-log/        # OTel plugin JSONL input
├── codex-log/              # OTel plugin JSONL input
└── wukong/                 # CLI API polling (Wukong desktop app)
```

每个 concrete input 目录通常只暴露一个 `<agent>-input.ts`，并通过 static `getWatchPaths()` / `checkAvailability()` 与 `AgentDiscoveryService` 对接。

### 生命周期 (Lifecycle)

```
init (constructor) → start() → [onStart() → runCycle() → setInterval] → stop() → [clearInterval → onStop()]
```

每个 cycle：调用 `collect()` → 非空时 emit `'entries'` → `stateStore.save()`

### 类继承树
```
BaseInput
 ├── BaseIdeInput       → IDE 本地文件快照轮询（使用 SnapshotStore dedup）
 ├── BaseSqliteInput    → SQLite rowid 游标增量查询
 ├── BaseHookInput      → Hook JSONL 日志字节偏移增量读取
 ├── BaseSessionInput   → Session 文件轮询（inode-aware rotation 检测）
 └── BaseCliForwarder   → CLI 遥测日志转发 + 过滤 + 归档
```

### 游标/去重策略

| Base Class | 策略 |
|-----------|-----|
| BaseIdeInput | SnapshotStore (key = filePath@@timestamp@@agentType) + highWatermark |
| BaseSqliteInput | 持久化 lastRowId 游标 |
| BaseHookInput | 每日文件的字节偏移 (lastFile + lastOffset) |
| BaseSessionInput | 每文件字节偏移 + inode rotation 检测 |
| BaseCliForwarder | 原始遥测文件的字节偏移 |

### 静态方法约定
每个具体 Input 类通常导出：
- `static getWatchPaths(): string[]` — 用于 AgentDiscoveryService fs.watch
- `static checkAvailability(): Promise<boolean>` — 检测 agent 数据目录是否存在

### Wukong CLI API Polling

Wukong 是项目里唯一不通过文件/SQLite/Hook 采集，而是通过 **CLI 子进程调用** 增量获取数据的 Input。它直接 `execFile` 调用 `wukong-cli`（macOS: `/Applications/Wukong.app/Contents/MacOS/wukong-cli`），解析 JSON 输出。这一节专门记录其特殊设计。

#### CLI 子命令

| 子命令 | 用途 |
|--------|------|
| `agent data list_tasks --json '{"limit":50,"cursor":"..."}'` | 分页列出所有 session（task），返回 `{items, hasMore, nextCursor}` |
| `agent data get_spark_agui_messages --json '{"conversationId":"..."}'` | 获取一个 session 的全部消息（含 AGUI 事件流） |

每次 `collect()` 周期：
1. `listAllTasks()` 拉取所有 task（最多 `MAX_TASKS=500`，超出时 warn）
2. 5-batch 并发（`COLLECT_CONCURRENCY=5`）调用 `getMessages` 拉每个 session 的消息
3. 增量切片：仅处理 `messages.slice(prevCount)`，且 `findLastCompleteIndex` 截掉尾部"streaming 中"和"无配对 assistant"的 user 消息
4. 通过 `transformMessages()` 将 AGUI 事件转换为 entries

#### State Schema（`extra` 字段）

Wukong 不复用 Base class 的游标，而是在 `state.extra` 下维护两个字段：

```ts
{
  seenCounts: Record<sessionId, number>     // 每 session 已处理的消息数（cursor）
  staleCounters: Record<sessionId, number>  // 连续 N 轮未在 list_tasks 出现的计数
}
```

`staleCounters` 是 grace-window：session 单次缺席不立即删除 cursor，必须连续缺席 `STALE_PRUNE_THRESHOLD=5` 轮才 prune，避免 list_tasks 分页边界 / 瞬时故障导致 churn 风暴（重发整个 session 历史）。

#### AGUI Event → Entry 映射

Wukong 数据源是 AGUI Protocol 事件流。以下事件被 `transformAssistantMessage()` 处理：

| AGUI Event | 触发动作 |
|------------|---------|
| `RUN_STARTED` | 捕获 `runId` (作为 `gen_ai.response.id`) 和起始时间戳 |
| `RUN_FINISHED` | 捕获结束时间戳；标记消息为"已完成"，可被 collect 处理 |
| `RUN_ERROR` | 捕获 `code` (作为 `error.type`) 和 `message` (作为 `error.message`)；触发 `finish_reasons=['stop']` |
| `STEP_STARTED` | 调用 `startNewStep()`：stepIndex++，生成新 stepSpanId，重置 per-step 累积器 |
| `STEP_FINISHED` | 调用 `flushStepLlm()`：emit 当前 step 的配对 `llm.request` + `llm.response`，使用 step 内累积的 textContent / usageEvent / runError，然后清空累积器 |
| `TEXT_MESSAGE_CONTENT` | 累积 `delta` 到 `textContent`（输出到 `gen_ai.output.messages`） |
| `TOOL_CALL_START` | 标记 `currentStep.hasToolCalls=true`；记录 toolCallId/toolName/timestamp；推入 `toolCallParts`（用于 LLM output_messages） |
| `TOOL_CALL_ARGS` | 流式累积 `delta` 到 `toolArgsAccumulator[toolCallId]`（最终作为 `gen_ai.tool.call.arguments`） |
| `TOOL_CALL_END` | emit `tool.call` + `tool.result` 配对（带 toolCallId、tool name、duration），duration 强制 ≥1ms 避免 0-duration TOOL span |
| `TOOL_CALL_RESULT` | 按 `toolCallId` 找已 emit 的 tool.result，补充 `gen_ai.tool.call.result` 完整内容；is_error 时设置 `error.type='_OTHER'` |
| `ACTIVITY_SNAPSHOT` | 内建工具（TERMINAL / FILE_WRITE / GREP_SEARCH / DIRECTORY_LIST / SKILL / ARTIFACT）映射为 `tool.call` + `tool.result` 对；`TASK_LINE_PLAN` 类型跳过 |
| `USAGE` | 捕获 token 计数（`prompt_tokens` / `completion_tokens` / `cached_tokens` / `total_tokens`） |
| `FIRST_TOKEN` | 捕获 TTFT 指标 (`ttft_ms` / `e2e_ttft_ms`) 落入 attributes |

#### Step 边界与 LLM 配对

Wukong 链路要求每个 STEP 恰好 1 个 LLM。实际数据有三种形态，用三层处理：

1. **正规多 step（有 STEP_STARTED / STEP_FINISHED 包夹）**
   - `flushStepLlm()` 在每个 STEP_FINISHED 时即时 emit 该 step 的真实 LLM 对（携带本 step 的 textContent / usageEvent / runError），并标记到 `flushedStepIds`，避免后续重复 emit

2. **无 STEP_STARTED 单消息（合成 step）**
   - 在事件循环开始前预创建 step `s1`
   - 若该 step 同时含 tools 和 text → 合成 split：emit s1 (tool_calls) + 启动 s2 (final answer)
   - 末尾的主 emit 块发出 currentStep 的 LLM 对

3. **缺 LLM 的 step（仅有 tools）**
   - Post-processing 扫描 `entries`，找出有 tool.call/tool.result 但无 LLM 对的 step
   - 合成 LLM 对（占位 user content `(continued)`，token=0）以满足 `structure.step_has_one_llm` 约束

#### messages_delta 增量化

为满足 `EVENT_LOG_TO_TRACE_SPEC.md` 中 "messages_delta 是 turn 内单调追加" 的语义：

- step 1 的 `llm.request.messages_delta`：用户原始 prompt（来自 `pendingUserMessages`，仅注入 step 1）
- step N (N≥2) 的 `llm.request.messages_delta`：由 post-processing 自动 prepend step N-1 的所有 tool 结果
  - 格式：`{role: 'tool', parts: [{type: 'tool_call_response', id: <tool_call_id>, response: <result>}]}`

这保证下游 `convertEventLogToTrace` 通过累积所有 step 的 messages_delta 还原完整 ReAct 上下文。

#### Trace ID 生成

每个 turn（assistant 消息）独立生成：
- `trace_id` = `crypto.randomBytes(16).toString('hex')`（W3C 32 hex chars）
- `agentSpanId`、每 step 的 `stepSpanId`、每 LLM/TOOL 的 `spanId` = `crypto.randomBytes(8).toString('hex')`（W3C 16 hex chars）
- entries 之间通过 `gen_ai.step.id` (`{turnId}:s{N}`) + `parent_span_id` 关联，让 OTLP converter 还原 ENTRY > AGENT > STEP > LLM/TOOL 树

注：Wukong 的 trace_id 是非确定性的，跨重启同一逻辑会话不会复用同一 trace_id（采用上游 daemon 没暴露稳定 traceId）。

#### 资源管理

- `_collectInFlight`：promise tracker，`onStop()` 通过 `await` 等待 in-flight 周期结束，避免孤儿子进程
- `_abortController`：传入每次 `execFile` 的 `signal` 选项；`onStop()` 调用 `.abort()` 主动取消正在运行的 wukong-cli 子进程
- `this.running` check：在 task 批与批之间检查，shutdown 时尽快退出
- `CLI_TIMEOUT_MS=10s`、`CLI_MAX_BUFFER=10MB`：执行级别的硬限制
- `_lastSkipWarnAt`：rate-limit 重入丢弃日志（每 60s 最多 1 条 warn）

#### 数据完整性约束

- **only complete messages**：`isMessageComplete()` 要求 assistant 消息含 `RUN_FINISHED` 或 `RUN_ERROR`；streaming 中的不完整消息留待下次 poll，避免 token 字段竞态
- **trim trailing user**：`findLastCompleteIndex()` 截掉尾部无配对 assistant 的 user 消息（避免空 ENTRY/AGENT span）
- **input sanitization**：`evt.timestamp` 经 `numOr()` 校验；`task.metadata` null-safe 访问；`JSON.parse` 失败时附 stderr + stdout 头部
- **runError 也触发 emit**：仅 RUN_STARTED + RUN_ERROR 的失败 turn 不会被静默丢弃，会 emit 一条带 error.type/error.message 的 llm.response

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AgentActivityEntry`, `ClientType`, `CollectionMethod`, `InputState`, `CodeGenerationEvent` |
| checkpoints | `StateStore`, `SnapshotStore` |
| normalization | `buildAgentActivityEntry` |
| utils | `createLogger`, `resolveHome`, `ensureDir`, `getTodayDateString`, `appendLine` |

## 扩展指南 (Extension Guide)

### 添加新 Agent Input

1. **选择合适的 Base Class**：
   - Agent 有 SQLite 数据库 → 继承 `BaseSqliteInput`
   - Agent 通过 Hook 脚本输出 JSONL → 继承 `BaseHookInput`
   - Agent 有 session/transcript 文件 → 继承 `BaseSessionInput`
   - Agent 有 IDE 本地历史快照 → 继承 `BaseIdeInput`
   - Agent 的 CLI 写入遥测日志需要转发 → 继承 `BaseCliForwarder`
   - Agent 仅暴露 CLI 接口（无文件/SQLite）→ 直接继承 `BaseInput`，参考 [Wukong CLI API Polling](#wukong-cli-api-polling)

2. **创建实现文件** `src/inputs/<agent-name>/<agent-name>-input.ts`：创建新 Input 需要继承对应的 Base class 并实现其 lifecycle 方法。参考现有实现: [src/inputs/qoder/qoder-input.ts](../../../src/inputs/qoder/qoder-input.ts)

3. **导出静态方法** `getWatchPaths()` 和 `checkAvailability()`。

4. **在 `ClientType` enum 中注册** 新 agent type。

5. **在 `Orchestrator.registerAllInputs()` 中注册**，构建 detection entry。

6. **如需安装 Hook** — 在 `HookManager` 中添加 `buildXxxHooks()` 静态方法。

## 约束 (Constraints)

1. **collect() 必须幂等且容错**：单次 cycle 失败不应丢失游标状态（catch 后 log warning 继续）。
2. **所有 entries 必须经过 entry-builder 标准化**：禁止直接构造 `AgentActivityEntry`。
3. **State key 唯一性**：每个 Input 的 `id` 全局唯一，用作 StateStore key。
4. **不允许跨 cycle 积累 entries**：每次 cycle 完毕后立即 emit，不做 buffering。
5. **onStart/onStop 是可选生命周期钩子**：不可在其中抛出中断性异常。
6. **pollIntervalMs 不得低于 5000ms**：避免过度资源消耗。
