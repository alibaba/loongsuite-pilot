# Cursor 链路采集修复经验总结

**时间**: 2026-06-02 ~ 2026-06-03
**背景**: 对 loongsuite-pilot 的 Cursor Agent 链路采集质量进行分析和修复

---

## 一、改动成果

### 成功的改动

| 改动 | 效果 | 验证状态 |
|------|------|---------|
| **Step 拆分** (converter.js) | 从 1 个 STEP 拆分为 7~8 个，每个 STEP 包含 1 个 LLM + 对应工具 | 已验证，trace d14bc603 拆出 8 个 step |
| **错误状态映射** (converter.js) | 中断/错误 turn 的 ENTRY/AGENT span 正确标记 status.code=2 | 已验证，aborted trace 正确标记 ERROR |
| **工具失败标记** (converter.js) | postToolUseFailure 的 TOOL span 标记为 ERROR | 已修改 |
| **tool_call_id 清洗** (normalizer) | 去除换行符，新 trace 0 个含换行 | 已验证 |
| **孤立 LLM endTime** (converter.js) | 中断 turn 的 LLM span duration 从 0s 恢复为实际时长 | 已验证 |
| **失败工具 result 补充** (field-mapping.js) | error.message 作为 result fallback | 已修改 |
| **Flusher 辅助事件跳过** (dist/index.js) | sessionStart/End, subagentStart/Stop 不再产生空壳 trace | 部分验证 |
| **Stop 事件 session 级广播** (dist/index.js) | stop 的 turn_id 与主 turn 不匹配时，广播到同 session 的 buffer | 部分验证 |

### 引入的问题

| 问题 | 原因 | 教训 |
|------|------|------|
| Codex trace 出现双重 ENTRY | 修改了 dist/index.js (OtlpTraceFlusher)，这是所有 agent 共用的 flusher | **不应在公共 flusher 中加 cursor 专属逻辑** |
| 多进程同时运行导致数据重复 | 语法检查 `node -e "import(...)"` 意外启动了完整 daemon | **验证语法应用 `node --check` 而非 import** |
| 残留进程未清理 | pkill 后未确认进程数，多次重启产生多个并行进程 | **每次重启后必须 `ps | grep` 确认只有 1 个进程** |

---

## 二、Step 拆分方案（核心成果）

### 方案设计

**问题**: Cursor 的多轮 ReAct 推理被压缩为单个 STEP，无法区分推理轮次。

**调研结论**:
- `generation_id` 不能用作 step_id（在整个 turn 内不变，已被用作 turn_id）
- `afterAgentThought` hook 是**唯一可用的 step 分界信号**

**事件序列**:
```
beforeSubmitPrompt  → step 0 开始
afterAgentThought   → step 1 开始（中间推理完成）
[tool.call/result]  → 工具执行，归属当前 step
afterAgentThought   → step 2 开始
[tool.call/result]  → 工具执行
afterAgentResponse  → step N（最终回复）
stop                → turn 结束
```

### 实现代码

在 `converter.js` 的 `convertTurn` 中，`groupByStep(records)` 之前插入：

```javascript
assignCursorStepIds(records);
```

新增函数：

```javascript
function assignCursorStepIds(records) {
    const agentType = records[0]?.["gen_ai.agent.type"];
    if (agentType !== "cursor" && agentType !== "cursor-hook") return;
    if (records.some(r => r["gen_ai.step.id"])) return;
    const sorted = [...records].sort((a, b) =>
        readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]));
    let stepRound = 0;
    const turnId = records[0]?.["gen_ai.turn.id"] ?? "unknown";
    let currentStepId = `${turnId}:s${stepRound}`;
    for (const r of sorted) {
        const hook = r["agent.cursor.hook_event_name"];
        if (hook === "afterAgentThought" || hook === "afterAgentResponse") {
            stepRound++;
            currentStepId = `${turnId}:s${stepRound}`;
        }
        r["gen_ai.step.id"] = currentStepId;
    }
}
```

**关键设计点**:
1. 第一行 `agentType !== "cursor"` 守卫，**不影响其他 agent**
2. `records.some(r => r["gen_ai.step.id"])` 跳过已有 step_id 的数据
3. 利用 converter 已有的 `groupByStep` 自动按 step_id 分组，无需改分组逻辑
4. step_id 格式 `${turnId}:s${stepRound}`，与 Claude Code 的 `${turnId}:s${stepRound}` 一致

### 验证结果

trace d14bc603 (168s, 42 tools):
```
STEP s0 (0~41s):   LLM + 16 tools (初始推理 + Grep/Read)
STEP s1 (42~50s):  LLM + 2 tools  (Shell + Read)
STEP s2 (50~56s):  LLM + 5 tools  (Read x5)
STEP s3 (64~77s):  LLM + 7 tools  (Shell + Read)
STEP s4 (82~113s): LLM + 4 tools  (Shell + Read)
STEP s5 (116~161s):LLM + 8 tools  (Shell + Read x7)
STEP s6 (163s):    LLM only       (推理无工具)
STEP s7 (167s):    LLM only       (最终回复)
```

---

## 三、Cursor Hook 调研成果

### 从 Cursor 3.5.38 源码提取的完整 Hook Payload

**PreToolUseRequestQuery**:
tool_name, tool_input, tool_use_id, cwd, conversation_id, generation_id, model, model_id, model_params

**PostToolUseRequestQuery**:
tool_name, tool_input, tool_output, duration_ms, tool_use_id, cwd, conversation_id, is_interrupt, generation_id, model, model_id, model_params

**PostToolUseFailureRequestQuery**:
tool_name, tool_input, error_message, failure_type, duration_ms, tool_use_id, is_interrupt, conversation_id, generation_id, model, model_id, model_params

**afterAgentThought** (从源码 + 实际数据):
conversation_id, generation_id, text, duration_ms, model

**beforeSubmitPrompt** (从源码):
conversation_id, generation_id, model, composer_mode, prompt, attachments

**afterAgentResponse** (从源码):
conversation_id, generation_id, model, text, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens

**stop** (从源码):
conversation_id, generation_id, model, status, loop_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens

### 关键发现

1. **generation_id 不是 step_id**: 在整个 turn 内保持不变，已被 normalizer 用作 gen_ai.turn.id
2. **afterAgentThought 是 step 分界**: 每次中间推理完成后触发，携带 reasoning 文本
3. **afterAgentThought 的 output type 是 "reasoning"**: 不是 "text"
4. **LLM 的 tool_use 决策不通过 hook 暴露**: 只在 Cursor 内部 transcript 中，需从 preToolUse 反向合成
5. **stop 事件携带独立 token**: 可用于中断 turn 的 token 补充
6. **postToolUseFailure 不携带 tool_output**: 只有 error_message + failure_type
7. **model 字段始终为 "default"**: model_id 字段可能有真实值，待验证
8. **tool_use_id 有复合格式**: "call_xxx\nfc_xxx"，需要清洗

### 未利用的字段

- model_id: 可能含真实模型名
- composer_mode: 可区分 Agent/Ask/Edit 模式
- cwd: 工具执行的工作目录
- is_interrupt: 工具是否被中断
- stop 的 token 字段: 可为中断 turn 补充 token
- attachments: 用户附件信息

---

## 四、与 Claude Code 的对比经验

### Claude Code 的优势

1. **双数据源**: hook stdin + transcript 解析，transcript 提供 model、token、message_id、output（含 tool_use）
2. **每轮独立 token**: transcript 每个 llm_call 都有独立 usage
3. **processor 生成 step_id**: 每个 llm_call 递增 stepRound，显式写入 gen_ai.step.id
4. **processor 生成 trace_id/span_id**: 完全可控的拓扑结构

### Cursor 的对标方案

| Claude Code 方式 | Cursor 对标 |
|-----------------|------------|
| transcript llm_call 拆 step | afterAgentThought 拆 step |
| transcript message.model | hook model_id (待验证) |
| transcript usage (每轮) | afterAgentResponse token (仅 turn 级) |
| transcript output (含 tool_use) | preToolUse 反向合成 (待实现) |

---

## 五、待解决问题

### 优先级 1（源码层面实现）

1. **Step 拆分**: 将 assignCursorStepIds 移入源码的 converter.ts
2. **tool_call_id 清洗**: normalizer 中 sanitizeToolCallId
3. **错误状态映射**: converter 中 resolveTurnError

### 优先级 2

4. **LLM output 合成 tool_use**: converter 中将 tool.call 事件合成到 LLM output.messages
5. **中断 turn 补 token**: normalizer 保留 stop 事件的 token，converter 做 fallback
6. **model_id 提取**: normalizer 提取 model_id 替代 "default"

### 优先级 3

7. **Flusher 辅助事件处理**: 需要在不影响其他 agent 的前提下解决 cursor 的 sessionStart/subagent 事件
8. **Stop 事件 turn_id 不匹配**: Cursor 的 stop 可能用不同的 turn_id，需要 session 级关联

---

## 六、操作教训

1. **不要在部署产物上改代码**: dist/index.js 和 node_modules 里的改动会被下次更新覆盖
2. **不要用 `node -e "import(...)"` 验证语法**: 会启动完整 daemon，应用 `node --check` 或只检查语法
3. **每次重启后确认只有 1 个进程**: `pkill -f collector-daemon && sleep 2 && ps aux | grep collector-daemon | grep -v grep | wc -l`
4. **公共模块的改动需要 agent 隔离**: flusher 是所有 agent 共用的，cursor 专属逻辑不应放在 flusher 中
5. **改动应该集中在 converter（按 agentType 守卫）或 normalizer（per-agent 函数）中**

---

## 七、文件改动清单（用于迁移到源码仓库）

### @loongsuite/otel-util-genai (loongsuite-js-plugins repo)

源码目录: `opentelemetry-util-genai/src/event-log/`

| 文件 | 改动 | 对应源文件 |
|------|------|----------|
| converter.js | assignCursorStepIds 函数 | converter.ts |
| converter.js | resolveTurnError 函数 + convertTurn 调用 | converter.ts |
| converter.js | convertToolPair 工具失败检查 | converter.ts |
| converter.js | convertLlmPair fallbackStartMs/EndMs | converter.ts |
| field-mapping.js | toolCallResult error fallback | field-mapping.ts |

### loongsuite-pilot (内部 repo)

| 文件 | 改动 | 对应源文件 |
|------|------|----------|
| hooks/agent-event-normalizer.mjs | sanitizeToolCallId 函数 | assets/hooks/agent-event-normalizer.mjs |
| dist/index.js (OtlpTraceFlusher) | 辅助事件跳过 + stop 广播 | src/flushers/otlp-trace-flusher.ts |

**注意**: dist/index.js 的改动（辅助事件跳过、stop 广播）影响了 codex，**不建议直接迁移**，需要重新设计为 cursor 专属逻辑，放在 normalizer 或 cursor-specific 的处理层中。
