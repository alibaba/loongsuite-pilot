## Context

三个独立 Input（QoderCliInput、QoderCliSessionInput、QoderSqliteInput）各自产出不完整的事件，进入不同 TurnBuffer 导致重复/割裂 trace。参照 qoder-work-trace 已验证的多源合并模式，新建 QoderTraceInput 在 Input 层完成合并，然后互斥禁用单源 Input。

## Goals / Non-Goals

**Goals:**
- 消除 qoder/qoder-cli 的重复 trace（§1）
- hook 事件补全 token 数据（§6）和真实时间戳（§5）
- hook 事件 step.id 按 LLM 调用边界正确切分（§3）
- user-input 事件符合 user-hook 识别规范（§4）
- 生成 trace_id 实现 SLS ↔ ARMS 关联（§2）
- event 日志质量提升（含 token，无重复）

**Non-Goals:**
- 不修改 genai-util 转换器逻辑
- 不修改 OtlpTraceFlusher 的 TurnBuffer 机制
- 不引入通用的跨 Input 合并框架（每个 agent 的合并逻辑不同）
- 不解决 model="auto"/"unknown" 问题（qoder 客户端限制，两个源都没有真实 model 名）

## Decisions

### D1: 合并在 Input 层（非 Flusher 层）

**选择**: 新建 QoderTraceInput（Input 层合并）

**原因**:
- Flusher 层合并有结构性时序问题（两个 Input 独立 poll，finish_reason 触发 flush 时另一个源的数据可能未到达）
- qoder-work-trace 已验证 Input 层合并模式可行
- Input 层控制读取时序，Stop hook 触发时 session segments 已完整落盘

### D2: 一个类处理 CLI + IDE，内部按 variant 分支

**选择**: 单一 QoderTraceInput 类，inferVariant() 区分后走不同合并路径

**原因**:
- 共享 80% 代码（hook 读取、step 重组、trace_id 生成）
- 现有 QoderCliInput 已用此模式
- 避免两个高度相似类的维护负担

### D3: QoderTraceInput 完全替代（非共存）

**选择**: 启用时禁用所有三个旧 Input

**原因**:
- 当前架构无 Input→Flusher 路由能力（MultiFlusher 无差别扇出）
- 共存会导致 SLS 收到重复 event
- qoder-work-trace 的已有模式就是完全替代

### D4: CLI join key = response_id（精确），IDE join key = session_id + timestamp（近似）

**验证数据**:
- CLI: hook `gen_ai.response.id` 与 segment `request_id` 精确匹配
- IDE: 时间戳差值 0-2ms，连续 assistant 最小间隔 2215ms，阈值 1000ms 安全余量 1215ms
- IDE 两级匹配：先 turn 级顺序匹配（SQLite request_id 数 == hook turn 数），再 turn 内时间戳匹配

### D5: Token 只写第一条 response

**选择**: 同一 response.id 的多条 llm.response（thinking+text 拆分）只给第一条写 token

**原因**:
- genai-util AGENT 聚合直接遍历原始 event（不经 response merge），写两条会双算
- genai-util LLM merge 用 "first non-zero" 策略，第一条有值即可
- 符合 EVENT_LOG_TO_TRACE_SPEC §3.4

### D6: 无 hook 数据的历史 session 保持兼容

**选择**: 对仅存在于 SQLite/segment（无对应 hook 事件）的历史数据，直接输出 token-only 事件

**原因**: 这些数据来自 hook 安装前的对话，没有内容可合并，但 token 数据不应丢失

## Implementation Approach

### Phase 1: hook-processor.mjs 修复

#### 1.1 step.id 重新赋值（hook-processor.mjs L254-263）

替换当前 "按 response 计数递增" 逻辑为 "按 response.id 变化 + llm.request 出现" 检测 LLM 调用边界：

```javascript
if (isQoderCli) {
  let stepCounter = 0;
  let lastResponseId = null;
  let assignedFirstResponse = false;

  for (const record of records) {
    const eventName = record['event.name'];
    const rawType = record['agent.qoder.raw_type'];

    // User-hook: 不赋 step.id
    if (eventName === 'llm.request' && rawType === 'user') {
      continue; // step.id remains undefined
    }

    // 检测新 LLM 调用边界
    if (eventName === 'llm.response') {
      const responseId = record['gen_ai.response.id'];
      if (!assignedFirstResponse || (responseId && responseId !== lastResponseId)) {
        stepCounter++;
        assignedFirstResponse = true;
      }
      if (responseId) lastResponseId = responseId;
    } else if (eventName === 'tool.call' || eventName === 'tool.result') {
      // tool 事件跟随当前 step
    }

    record['gen_ai.step.id'] = `${turnId}:s${stepCounter}`;
  }
}
```

#### 1.2 user-hook model 修复（agent-event-normalizer.mjs L434）

```javascript
const model = rowType === 'user' ? undefined : (getStringValue(message, 'model') || 'unknown');
```

### Phase 2: QoderTraceInput 实现

#### 文件结构

```
src/inputs/qoder-trace/
  ├── qoder-trace-input.ts          # 主类 (extends BaseInput)
  ├── segment-token-reader.ts       # 读 session segments: token + timestamps
  ├── sqlite-token-reader.ts        # 读 SQLite: token + request_id
  └── token-enricher.ts             # 合并逻辑: match + inject
```

#### 主类 collect() 流程

```typescript
class QoderTraceInput extends BaseInput {
  readonly id = 'qoder-trace';
  readonly agentType = ClientType.QoderCli; // 动态覆盖 per entry
  readonly collectionMethod = CollectionMethod.HookJsonl;

  protected async collect(): Promise<AgentActivityEntry[]> {
    // 1. 读 hook JSONL 新增行（offset 追踪）
    const rawRecords = await this.readNewHookLines();

    // 2. 逐行 transform（复用 QoderCliInput 逻辑）
    const entries = await this.transformRecords(rawRecords);
    if (entries.length === 0) return this.collectOrphanTokenEvents();

    // 3. 按 turn.id 分组
    const turnGroups = this.groupByTurn(entries);

    // 4. 每个 turn: 按 variant 合并 token
    const enrichedEntries: AgentActivityEntry[] = [];
    for (const [turnId, turnEntries] of turnGroups) {
      const variant = this.inferTurnVariant(turnEntries);
      const enriched = variant === 'qoder-cli'
        ? await this.enrichWithSegments(turnEntries)
        : await this.enrichWithSqlite(turnEntries);

      // 5. 生成 trace_id
      const traceId = crypto.randomBytes(16).toString('hex');
      for (const e of enriched) {
        e.trace_id = traceId;
      }
      enrichedEntries.push(...enriched);
    }

    return enrichedEntries;
  }
}
```

#### segment-token-reader.ts

```typescript
interface SegmentTokenData {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestStartTs: string;  // model.request.started ISO timestamp
  responseEndTs: string;   // model.response.completed ISO timestamp
  stopReason: string;
}

// 按 session_id 读取所有 model.request.started + model.response.completed 事件
function readSegmentTokens(sessionId: string): SegmentTokenData[];
```

#### sqlite-token-reader.ts

```typescript
interface SqliteTokenData {
  requestId: string;
  gmtCreate: number;       // ms timestamp
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

// 按 session_id 查询 chat_message WHERE token_info IS NOT NULL
function readSqliteTokens(sessionId: string): SqliteTokenData[];
```

#### token-enricher.ts 合并策略

```typescript
// CLI: 精确匹配
function enrichCliTurn(entries: Entry[], segments: SegmentTokenData[]): Entry[] {
  for (const seg of segments) {
    // 找 response.id == seg.requestId 的 hook events
    const matches = entries.filter(e =>
      e['gen_ai.response.id'] === seg.requestId && e['event.name'] === 'llm.response');
    if (matches.length > 0) {
      // 只给第一条写 token
      matches[0]['gen_ai.usage.input_tokens'] = seg.inputTokens;
      matches[0]['gen_ai.usage.output_tokens'] = seg.outputTokens;
      // 替换时间戳为真实值
      matches[0]['time_unix_nano'] = seg.responseEndTs;
      // 其余条置 0
      for (let i = 1; i < matches.length; i++) {
        matches[i]['gen_ai.usage.input_tokens'] = 0;
      }
    }
    // 找对应的 llm.request，注入真实开始时间
    const req = entries.find(e =>
      e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === matches[0]?.['gen_ai.step.id']);
    if (req) req['time_unix_nano'] = seg.requestStartTs;
  }
}

// IDE: 两级近似匹配
function enrichIdeTurn(entries: Entry[], sqliteRows: SqliteTokenData[]): Entry[] {
  // === 第一级: Turn → request_id 顺序匹配 ===
  // 验证: SQLite unique request_ids 数 == hook unique turn_ids 数
  // 按 MIN(gmt_create) 排序 request_id 组，按时间顺序与 hook turns 1:1 对应
  // hook turn_id[0] ↔ SQLite request_id[0]
  // hook turn_id[1] ↔ SQLite request_id[1]
  // ...
  // 这一步确定了每个 turn 对应的 SQLite request_id 组

  // === 第二级: Turn 内 LLM 调用级时间戳匹配 (≤1000ms) ===
  // 搜索范围已被第一级缩小到同一 turn/request_id 的 rows
  // 对同一 request_id 下的每条 SQLite row:
  //   找 hook events 中 timestamp 差 ≤1000ms 的最近 llm.response
  //   注入 token 到匹配的 hook event
  //   将 SQLite request_id 作为 gen_ai.response.id 注入

  // === Token 注入规则 ===
  // 同一 response.id 的多条只第一条有 token，其余置 0

  // 数据验证基础:
  // - 实际时间差: 0-2ms
  // - 连续 assistant 最小间隔: 2215ms (全量) / 6872ms (大 session)
  // - 阈值 1000ms: 安全余量 1215ms，误匹配风险几乎为零
}
```

### Phase 3: Orchestrator 集成

```typescript
// orchestrator.ts registerAllInputs()

// 注册 QoderTraceInput
const qoderTraceInput = new QoderTraceInput({ stateStore, logDir: qoderCliLogDir });
this.inputManager.registerInput(qoderTraceInput);

const qoderTraceEnabled = () =>
  this.isAgentGatedEnabled(Orchestrator.LISTENER_AGENT_MAP['qoder-trace']) &&
  this.agentControlManager.resolveEnabled('qoder-trace', listenerCfg['qoder-trace']?.enabled ?? true);

entries.push(this.inputManager.buildDetectionEntry(qoderTraceInput, {
  watchPaths: QoderTraceInput.getWatchPaths(),
  isAvailable: QoderTraceInput.checkAvailability,
  enabled: qoderTraceEnabled,
  pollIntervalMs: listenerCfg['qoder-trace']?.pollInterval,
}));

// 互斥守卫：qoder-cli-hook, qoder-cli-session, qoder-sqlite
// enabled: () => !qoderTraceEnabled() && <original conditions>
```

## Risks

- **中风险**: event 日志数量变化（从 ~3600 降到 ~200 条/天）。被消除的是纯 token 事件（低信息密度），但下游 SLS 查询如果依赖这些事件需要调整。
- **低风险**: IDE 时间戳匹配的边界情况。阈值 1000ms 有 1215ms 安全余量，实测 0-2ms 差值。
- **低风险**: 历史 session（仅 SQLite 无 hook）的兼容处理。`collectOrphanTokenEvents()` 保持原行为。
