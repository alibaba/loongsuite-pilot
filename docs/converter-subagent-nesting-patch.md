# Converter Subagent Nesting Patch

> 针对 `@loongsuite/otel-util-genai@0.1.0-beta.3` 的本地补丁，待合入上游仓库后移除。

## 修改文件

`dist/event-log/converter.js`（编译产物，源码在 `loongsuite-js-plugins` 仓库）

## 改动目的

让 converter 支持 Subagent 嵌套——当父 agent 的 TOOL span 有关联的子 session records 时，在 TOOL span 下创建嵌套的 `AGENT → STEP → LLM/TOOL` 层级。

改动前的 span 层级：
```
ENTRY → AGENT → STEP → LLM + TOOL(Subagent)
```

改动后的 span 层级：
```
ENTRY → AGENT → STEP → LLM + TOOL(Subagent)
                                  └── AGENT(child) → STEP → LLM + TOOL
```

## 改动内容

### 1. 父子 record 分离（convertTurn 函数）

在 `convertTurn` 中，遍历 records 时按 `gen_ai.agent.scope === "subagent"` 将子 session records 分离出来，按 `gen_ai.subagent.parent_tool_call.id` 分组存入 `childRecordsByCallId` Map。

剩余的 parentRecords 用于构建父 turn 的 ENTRY/AGENT/STEP/LLM 等 span，避免子 session 的 records 污染父级的 outputMessages、token 汇总等字段。

```js
const parentRecords = [];
const childRecordsByCallId = new Map();
for (const r of records) {
    if (r["gen_ai.agent.scope"] === "subagent") {
        const callId = r["gen_ai.subagent.parent_tool_call.id"];
        if (callId) {
            let list = childRecordsByCallId.get(callId);
            if (!list) { list = []; childRecordsByCallId.set(callId, list); }
            list.push(r);
        }
    } else {
        parentRecords.push(r);
    }
}
```

原先所有用 `records` 的地方改为 `parentRecords`：
- `resolveTurnAgentName / UserId / SessionId`
- `buildEntryInvocation / buildInvokeAgentInvocation`
- `readTurnSystemInstruction / readTurnToolDefinitions`
- `buildTurnAccumulatedMessages / groupByStep`

### 2. childRecordsByCallId 透传

`childRecordsByCallId` 通过 `convertStep → convertToolPair` 逐层传递。函数签名增加参数：

- `convertStep(step, handler, agentCtx, ..., childRecordsByCallId)`
- `convertToolPair(pair, handler, parentCtx, common, childRecordsByCallId, warnings)`

### 3. TOOL span 内嵌套子 AGENT（convertToolPair 函数）

在 `convertToolPair` 中，当 `pair.call["gen_ai.tool.call.id"]` 在 `childRecordsByCallId` 中有匹配时，在 TOOL span 下创建嵌套结构：

```js
let startMs = pair.call
    ? readNanoMs(pair.call["time_unix_nano"])
    : readNanoMs(pair.result["time_unix_nano"]);
// ... endMs 计算省略 ...
const toolInv = buildExecuteToolInvocation(pair, common);

const toolCallId = pair.call?.["gen_ai.tool.call.id"];
const childRecords = childRecordsByCallId?.get(toolCallId);
// Guard: if child records start earlier than TOOL (e.g. LLM request
// time pushed back by duration_ms), pull TOOL start forward to match.
if (childRecords && childRecords.length > 0) {
    const childMinMs = minTime(childRecords);
    if (childMinMs < startMs) startMs = childMinMs;
}
handler.startExecuteTool(toolInv, parentCtx, startMs);
if (childRecords && childRecords.length > 0) {
    const toolCtx = toolInv.contextToken ?? undefined;
    const childCommon = {
        agentName: resolveTurnAgentName(childRecords, []) ?? common.agentName,
        userId: common.userId,
        sessionId: common.sessionId,
    };
    const childAgentInv = buildInvokeAgentInvocation(childRecords, [], childCommon);
    const childStartMs = minTime(childRecords);
    const childEndMs = maxTime(childRecords);
    handler.startInvokeAgent(childAgentInv, toolCtx, childStartMs);
    const childAgentCtx = childAgentInv.contextToken ?? undefined;

    const childAccumulatedMap = buildTurnAccumulatedMessages(childRecords);
    const childSteps = groupByStep(childRecords);
    for (const step of childSteps) {
        convertStep(step, handler, childAgentCtx, null, null,
            childAccumulatedMap, childCommon, warnings ?? [], false);
    }
    handler.stopInvokeAgent(childAgentInv, childEndMs);
    if (childEndMs > endMs) endMs = childEndMs;
}
```

要点：
- TOOL span 开始时间兜底：如果 child records 的最早时间（可能被 LLM thought duration_ms 回推）早于 TOOL 原始 start，TOOL start 被拉前到 child 最早时间，保证容器 span 包裹住子级
- `startExecuteTool` 在 child 时间检查之后调用（原始代码在之前），确保使用修正后的 startMs
- 子 AGENT 的 `agentName` 通过 `resolveTurnAgentName(childRecords, [])` 解析，优先取 `gen_ai.agent.name` → `gen_ai.agent.type` → 继承父级
- 子 AGENT 的 parentContext 是 TOOL span 的 context（`toolCtx`），确保 parentSpanId 指向 TOOL
- 子 AGENT 的时间范围由子 records 的 min/max time 决定
- 如果子 AGENT 结束时间晚于 TOOL result 时间，TOOL span 的 endTime 延伸到子 AGENT 结束时间
- 子 step 的 `turnSysInstr` 和 `turnToolDefs` 传 null（子 session 没有独立的 system instruction）
- spanCount 返回值包含嵌套的 span 数量

## 上游 record 的协议要求

assembler 产出的子 session records 需要携带以下字段，converter 才能正确识别和嵌套：

| 字段 | 用途 |
|------|------|
| `gen_ai.agent.scope` = `"subagent"` | 标识为子 session record |
| `gen_ai.subagent.parent_tool_call.id` | 关联到父 TOOL 的 `gen_ai.tool.call.id` |
| `gen_ai.agent.id` | 子 session 标识（conversation_id） |
| `gen_ai.step.id` | 子 session 内的 step 划分 |
| `event.name` | 标准事件名（llm.request / llm.response / tool.call / tool.result） |

## 对现有探针的影响

converter 的改动是纯增量的——只在 records 包含 `gen_ai.agent.scope === "subagent"` 时才激活嵌套逻辑，不携带该字段的 records 走原有路径，行为不变。

| 探针 | 子 agent 能力 | 影响 |
|------|--------------|------|
| **Cursor** | 已接入。`react-assembler.mjs` 产出带协议字段的 child records | converter 补丁直接生效 |
| **Claude Code** | hook processor 已收集 `subagent_start` / `subagent_stop` 事件和 `_child_state`，但尚未在 records 中设置协议字段 | 无影响，需在 record 构建层补上协议字段后才能使用嵌套 |
| **Codex** | hook 无子 agent 事件 | 无影响 |
| **Qoder / QoderWork** | hook 无子 agent 事件 | 无影响 |

## 其他探针接入 subagent 嵌套的步骤

converter 侧不需要任何改动，只需要探针的 hook processor / assembler 在产出 records 时满足协议要求。以 Claude Code 为例：

### 1. 识别子 agent 的 records 来源

Claude Code 已经在 `cmdSubagentStop` 中通过 `readAndDeleteChildState(childSid)` 读取了子 session 的完整事件列表（`_child_state.events`）。这些事件等价于 Cursor 的 `childEvents`。

### 2. 为 child records 设置协议字段

在构建子 session 的 event log records 时（等价于 Cursor 的 `buildParentSteps(childEvents, ...)`），需要在每条 record 上注入：

```js
'gen_ai.agent.scope': 'subagent',                    // 必须：标识为子 session
'gen_ai.subagent.parent_tool_call.id': toolCallId,    // 必须：关联父 TOOL span
'gen_ai.agent.id': childSessionId,                    // 建议：子 session 标识
'gen_ai.agent.depth': 1,                              // 建议：嵌套深度
'gen_ai.agent.parent.id': parentSessionId,             // 建议：父 session 标识
```

其中 `toolCallId` 需要建立父级 tool.call 与子 session 的对应关系——哪个 tool.call 触发了哪个子 agent。

### 3. 关联 parent tool.call 与 child session

这是接入的核心难点。需要在父 session 的 `preToolUse`（或等价事件）中找到触发子 agent 的 tool call，将其 `tool_use_id` / `tool.call.id` 与子 session 的 `subagent_session_id` 建立映射。映射策略视 agent 而异：

- **Cursor**：通过 transcript 目录下的 `subagents/*.jsonl` 文件名与 `preToolUse` 事件的时间顺序匹配
- **Claude Code**：`subagentStop` 事件携带 `subagent_session_id`，需要关联到最近的未配对的 Agent/Task 类 tool call

### 4. 将 child records 与 parent records 合并输出

child records 和 parent records 放入同一个 records 数组发送给 converter。converter 会自动按 `gen_ai.agent.scope` 分离，按 `gen_ai.subagent.parent_tool_call.id` 匹配到对应的 TOOL span 下。

## 部署注意

此补丁在 `node_modules` 中，每次 `npm install` 会丢失。`scripts/local-reinstall.sh` 的 Step 6 负责将补丁从开发目录复制到部署版本的 `node_modules`。正式方案是将改动合入 `@loongsuite/otel-util-genai` 源码发布新版本。
