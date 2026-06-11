# GenAI Trace 自动化校验方案设计

> **目的**：建设"按照 ARMS GenAI 语义规范自动校验 pilot 产出的 trace 数据"的能力，支持开发时手动触发（skill）和 CI/E2E 自动执行两种场景。
>
> **适用范围**：通用于所有 agent（qoder/qoder-cli/claude-code/codex/cursor 等）。
>
> **规范来源**：
> - ARMS GenAI 语义规范：https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/arms_docs/trace/gen-ai.md
> - 消息体 JSON Schema：https://code.alibaba-inc.com/arms/semantic-conventions/tree/arms/arms_docs/trace/gen-ai_messages_schema
> - 本地副本：`docs/EVENT_LOG_TO_TRACE_SPEC.md`

---

## 1. 架构概览

```
                    ┌─────────────────────────────────────────────┐
                    │           校验规则定义                        │
                    │  docs/trace-validation-rules.json            │
                    │  (从 gen-ai.md 提取的结构化规则)              │
                    └──────────────┬──────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────────────┐
                    │           校验引擎 (核心)                     │
                    │  scripts/validate-trace.mjs                  │
                    │                                              │
                    │  输入: otlp-debug/*.jsonl                    │
                    │  输出: structured JSON report                │
                    │                                              │
                    │  CLI 用法:                                    │
                    │    node scripts/validate-trace.mjs            │
                    │      --input <jsonl-file-or-glob>             │
                    │      --latest (自动发现最新 JSONL)            │
                    │      --rules docs/trace-validation-rules.json │
                    │      --format json|text|summary               │
                    │      --output report.json (可选)              │
                    └──────┬───────────────────┬──────────────────┘
                           │                   │
              ┌────────────▼────────┐  ┌───────▼──────────────┐
              │  Skill 包装层        │  │  CI/E2E 集成          │
              │  assets/skills/     │  │  scripts/e2e/         │
              │  validate-trace/    │  │  run-e2e.sh 调用      │
              │  SKILL.md           │  │  validate-trace.mjs   │
              │                     │  │  exit code:           │
              │  触发: /validate-   │  │    0=pass, 1=fail     │
              │    trace <file>     │  │                       │
              │  读取 JSON 报告     │  │                       │
              │  格式化展示给用户   │  │                       │
              └─────────────────────┘  └───────────────────────┘

              ┌─────────────────────────────────────────────────┐
              │  规则更新工具                                     │
              │  scripts/update-validation-rules.mjs             │
              │                                                  │
              │  从 GitLab 拉取最新 gen-ai.md + JSON Schema      │
              │  解析生成 trace-validation-rules.json             │
              └─────────────────────────────────────────────────┘
```

---

## 2. 校验维度

### 2.1 结构校验

| 规则 ID | 描述 | 严重度 |
|---------|------|--------|
| `structure.single_entry` | 每个 trace 有且仅有 1 个 ENTRY span | ERROR |
| `structure.single_agent` | 每个 trace 有且仅有 1 个 AGENT span | ERROR |
| `structure.entry_is_root` | ENTRY span 是 trace 的根 span（无 parent 或 parent 为合成 root） | ERROR |
| `structure.agent_under_entry` | AGENT span 的 parent 是 ENTRY span | ERROR |
| `structure.step_under_agent` | STEP span 的 parent 是 AGENT span | ERROR |
| `structure.llm_under_step` | LLM span 的 parent 是 STEP span | ERROR |
| `structure.tool_under_step` | TOOL span 的 parent 是 STEP span | ERROR |
| `structure.step_has_one_llm` | 每个 STEP 恰好包含 1 个 LLM 子 span | ERROR |
| `structure.llm_before_tools` | STEP 下 LLM span 的 startTime 早于所有同级 TOOL span 的 startTime | ERROR |
| `structure.no_orphan_spans` | 所有 span 都能通过 parentSpanId 链接到 ENTRY | ERROR |

### 2.2 属性完整性校验

按 span kind 分别校验 MUST / SHOULD 字段是否存在。

**公共 Attributes（所有 span 均须携带）：**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.session.id` | MUST | 同 trace 内所有 span 的值必须一致 |
| `gen_ai.user.id` | MUST | 同 trace 内所有 span 的值必须一致 |
| `gen_ai.agent.name` | SHOULD | |

**ENTRY span:**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.span.kind` = "ENTRY" | MUST | |
| `gen_ai.operation.name` = "enter" | SHOULD | |
| `gen_ai.input.messages` | SHOULD | 需 captureMessageContent |
| `gen_ai.output.messages` | SHOULD | 需 captureMessageContent |

**AGENT span:**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.span.kind` = "AGENT" | MUST | |
| `gen_ai.operation.name` = "invoke_agent" | MUST | |
| `gen_ai.agent.name` | MUST | |
| `gen_ai.provider.name` | SHOULD | |
| `gen_ai.usage.input_tokens` | SHOULD | |
| `gen_ai.usage.output_tokens` | SHOULD | |
| `gen_ai.usage.total_tokens` | SHOULD | = input + output |
| `gen_ai.input.messages` | SHOULD | 需 captureMessageContent |
| `gen_ai.output.messages` | SHOULD | 需 captureMessageContent |

**STEP span:**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.span.kind` = "STEP" | MUST | |
| `gen_ai.operation.name` = "react" | SHOULD | |
| `gen_ai.react.round` | SHOULD | 从 1 开始递增 |
| `gen_ai.react.finish_reason` | SHOULD | |

**LLM span:**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.span.kind` = "LLM" | MUST | |
| `gen_ai.operation.name` ∈ ["chat", "generate_content", "text_completion"] | MUST | |
| `gen_ai.provider.name` | MUST | |
| `gen_ai.request.model` | MUST | |
| `gen_ai.response.model` | SHOULD | |
| `gen_ai.response.id` | SHOULD | |
| `gen_ai.response.finish_reasons` | SHOULD | string[] 格式 |
| `gen_ai.usage.input_tokens` | SHOULD | |
| `gen_ai.usage.output_tokens` | SHOULD | |
| `gen_ai.usage.total_tokens` | SHOULD | = input + output |
| `gen_ai.input.messages` | SHOULD | 需 captureMessageContent |
| `gen_ai.output.messages` | SHOULD | 需 captureMessageContent |

**TOOL span:**
| 字段 | 等级 | 说明 |
|------|------|------|
| `gen_ai.span.kind` = "TOOL" | MUST | |
| `gen_ai.operation.name` = "execute_tool" | MUST | |
| `gen_ai.tool.name` | MUST | |
| `gen_ai.tool.call.id` | SHOULD | |
| `gen_ai.tool.call.arguments` | SHOULD | 需 captureMessageContent |
| `gen_ai.tool.call.result` | SHOULD | 需 captureMessageContent |

**Resource 属性（所有 span）：**
| 字段 | 等级 |
|------|------|
| `service.name` | MUST |
| `acs.arms.service.feature` = "genai_app" | SHOULD |

### 2.3 时间校验

| 规则 ID | 描述 | 严重度 |
|---------|------|--------|
| `time.non_zero_duration` | 所有 span 的 startTime < endTime（无 0ms span） | ERROR |
| `time.no_step_overlap` | 同一 AGENT 下的 STEP span 之间无时间重叠 | ERROR |
| `time.parent_contains_children` | 父 span 的 [start, end] 严格包含所有子 span 的 [start, end]，无容差 | ERROR |
| `time.reasonable_duration` | LLM span 时长 < 10 分钟（超长可能异常） | WARN |
| `time.chronological_steps` | STEP 的 round 编号递增顺序与时间顺序一致 | WARN |

### 2.4 数据格式校验

| 规则 ID | 描述 | 严重度 | 前置条件 |
|---------|------|--------|---------|
| `schema.input_messages` | `gen_ai.input.messages` 符合 `specs/gen-ai-input-messages.json` | ERROR | captureMessageContent |
| `schema.output_messages` | `gen_ai.output.messages` 符合 `specs/gen-ai-output-messages.json` | ERROR | captureMessageContent |
| `schema.finish_reasons` | `gen_ai.response.finish_reasons` 是字符串数组 | WARN | - |
| `schema.tokens_positive` | token 值为非负整数 | ERROR | - |
| `schema.tokens_sum` | `gen_ai.usage.total_tokens` = `input_tokens` + `output_tokens`（当三者都存在时） | ERROR | - |
| `schema.trace_id_format` | traceId 为 32 位小写 hex 字符串 | ERROR | - |
| `schema.span_id_format` | spanId 为 16 位小写 hex 字符串 | ERROR | - |
| `schema.span_kind_enum` | `gen_ai.span.kind` ∈ ["ENTRY", "AGENT", "STEP", "LLM", "TOOL", "EMBEDDING", "RETRIEVER", "RERANKER", "CHAIN", "TASK"] | ERROR | - |

### 2.5 语义一致性校验

| 规则 ID | 描述 | 严重度 | 前置条件 |
|---------|------|--------|---------|
| `semantic.agent_token_sum` | AGENT 的 input_tokens = Σ(所有后代 LLM 的 input_tokens)，output 和 total 同理 | ERROR | - |
| `semantic.tool_matches_llm_output` | STEP 下的每个 TOOL span 的 `tool.call.id` 或 `tool.name` 必须能在同级 LLM span 的 `output.messages` 中的 `tool_call` parts 找到对应；反之亦然 | ERROR | captureMessageContent |
| `semantic.entry_input_exists` | ENTRY span 有 `input.messages` 且非空 | WARN | captureMessageContent |
| `semantic.entry_output_matches` | ENTRY 的 `output.messages` 与最后一个 LLM 的 `output.messages` 一致 | WARN | captureMessageContent |
| `semantic.consistent_session_id` | 同一 trace 内所有 span 的 `gen_ai.session.id` 值一致 | ERROR | - |
| `semantic.consistent_user_id` | 同一 trace 内所有 span 的 `gen_ai.user.id` 值一致 | ERROR | - |
| `semantic.consistent_agent_name` | 同一 trace 内所有 span 的 `gen_ai.agent.name` 值一致 | WARN | - |
| `semantic.llm_has_input_output` | 每个 LLM span 同时有 `input.messages` 和 `output.messages` | WARN | captureMessageContent |
| `semantic.operation_kind_mapping` | `gen_ai.operation.name` 与 `gen_ai.span.kind` 的映射关系正确（如 chat→LLM, execute_tool→TOOL） | ERROR | - |
| `semantic.span_name_pattern` | span name 符合 `{operation_name} {qualifier}` 模式 | WARN | - |
| `semantic.tool_response_role` | LLM `input.messages` 中包含 `tool_call_response` type part 的消息，其 role 必须为 `tool` | ERROR | captureMessageContent |
| `semantic.last_step_no_tool_call` | 最后一个 STEP 的 LLM span 的 `output.messages` 不应包含 `tool_call` type part（即最终轮应为纯文本回答，finish_reason 不应为 `tool_call`） | ERROR | captureMessageContent |

---

## 3. captureMessageContent 检测与 SKIPPED 机制

### 3.1 检测逻辑

引擎在开始校验前，扫描所有 span 的 attributes，判断 `captureMessageContent` 是否开启：

```
如果整个 trace 中没有任何 span 包含 gen_ai.input.messages 或 gen_ai.output.messages
  → captureMessageContent = false
否则
  → captureMessageContent = true
```

### 3.2 SKIPPED 行为

当 `captureMessageContent = false` 时，以下规则标记为 **SKIPPED**：
- `schema.input_messages`
- `schema.output_messages`
- `semantic.tool_matches_llm_output`
- `semantic.entry_input_exists`
- `semantic.entry_output_matches`
- `semantic.llm_has_input_output`
- 属性校验中标注"需 captureMessageContent"的 SHOULD 字段

SKIPPED 规则：
- **不计入** pass/fail/warn 统计
- **不影响** exit code
- 在报告中单独计数并标注原因：`SKIPPED (captureMessageContent not enabled)`

---

## 4. 校验规则文件

### 4.1 文件格式：`docs/trace-validation-rules.json`

```jsonc
{
  "version": "1.0",
  "generatedAt": "2026-06-04T00:00:00Z",
  "specSource": "https://code.alibaba-inc.com/arms/semantic-conventions/blob/arms/arms_docs/trace/gen-ai.md",

  "commonAttributes": {
    "must": [
      { "key": "gen_ai.session.id" },
      { "key": "gen_ai.user.id" }
    ],
    "should": [
      { "key": "gen_ai.agent.name" }
    ]
  },

  "spanKinds": {
    "ENTRY": {
      "namePattern": "enter_ai_application_system",
      "operationName": "enter",
      "multiplicity": "exactly_one",
      "parentKind": null,
      "allowedChildren": ["AGENT"],
      "attributes": {
        "must": [
          { "key": "gen_ai.span.kind", "expectedValue": "ENTRY" }
        ],
        "should": [
          { "key": "gen_ai.operation.name", "expectedValue": "enter" },
          { "key": "gen_ai.input.messages", "schema": "input_messages", "requiresMessageContent": true },
          { "key": "gen_ai.output.messages", "schema": "output_messages", "requiresMessageContent": true }
        ]
      }
    },
    "AGENT": {
      "namePattern": "invoke_agent {gen_ai.agent.name}",
      "operationName": "invoke_agent",
      "multiplicity": "exactly_one",
      "parentKind": "ENTRY",
      "allowedChildren": ["STEP"],
      "attributes": {
        "must": [
          { "key": "gen_ai.span.kind", "expectedValue": "AGENT" },
          { "key": "gen_ai.operation.name", "expectedValue": "invoke_agent" },
          { "key": "gen_ai.agent.name" }
        ],
        "should": [
          { "key": "gen_ai.provider.name" },
          { "key": "gen_ai.usage.input_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.usage.output_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.usage.total_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.input.messages", "schema": "input_messages", "requiresMessageContent": true },
          { "key": "gen_ai.output.messages", "schema": "output_messages", "requiresMessageContent": true }
        ]
      },
      "aggregation": {
        "gen_ai.usage.input_tokens": { "rule": "sum", "source": "LLM" },
        "gen_ai.usage.output_tokens": { "rule": "sum", "source": "LLM" },
        "gen_ai.usage.total_tokens": { "rule": "sum", "source": "LLM" }
      }
    },
    "STEP": {
      "namePattern": "react step",
      "operationName": "react",
      "multiplicity": "one_or_more",
      "parentKind": "AGENT",
      "allowedChildren": ["LLM", "TOOL"],
      "attributes": {
        "must": [
          { "key": "gen_ai.span.kind", "expectedValue": "STEP" }
        ],
        "should": [
          { "key": "gen_ai.operation.name", "expectedValue": "react" },
          { "key": "gen_ai.react.round", "type": "integer", "min": 1 },
          { "key": "gen_ai.react.finish_reason" }
        ]
      },
      "constraints": [
        { "rule": "exactly_one_child_of_kind", "kind": "LLM" },
        { "rule": "llm_starts_before_all_tools" },
        { "rule": "no_time_overlap_between_siblings" }
      ]
    },
    "LLM": {
      "namePattern": "{gen_ai.operation.name} {gen_ai.request.model}",
      "operationName": ["chat", "generate_content", "text_completion"],
      "multiplicity": "one_or_more",
      "parentKind": "STEP",
      "allowedChildren": [],
      "attributes": {
        "must": [
          { "key": "gen_ai.span.kind", "expectedValue": "LLM" },
          { "key": "gen_ai.operation.name" },
          { "key": "gen_ai.provider.name" },
          { "key": "gen_ai.request.model" }
        ],
        "should": [
          { "key": "gen_ai.response.model" },
          { "key": "gen_ai.response.id" },
          { "key": "gen_ai.response.finish_reasons", "type": "string_array" },
          { "key": "gen_ai.usage.input_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.usage.output_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.usage.total_tokens", "type": "integer", "min": 0 },
          { "key": "gen_ai.input.messages", "schema": "input_messages", "requiresMessageContent": true },
          { "key": "gen_ai.output.messages", "schema": "output_messages", "requiresMessageContent": true }
        ]
      }
    },
    "TOOL": {
      "namePattern": "execute_tool {gen_ai.tool.name}",
      "operationName": "execute_tool",
      "multiplicity": "zero_or_more",
      "parentKind": "STEP",
      "allowedChildren": [],
      "attributes": {
        "must": [
          { "key": "gen_ai.span.kind", "expectedValue": "TOOL" },
          { "key": "gen_ai.operation.name", "expectedValue": "execute_tool" },
          { "key": "gen_ai.tool.name" }
        ],
        "should": [
          { "key": "gen_ai.tool.call.id" },
          { "key": "gen_ai.tool.call.arguments", "requiresMessageContent": true },
          { "key": "gen_ai.tool.call.result", "requiresMessageContent": true }
        ]
      }
    }
  },

  "operationKindMapping": {
    "chat": "LLM",
    "generate_content": "LLM",
    "text_completion": "LLM",
    "execute_tool": "TOOL",
    "invoke_agent": "AGENT",
    "create_agent": "AGENT",
    "embeddings": "EMBEDDING",
    "retrieval": "RETRIEVER",
    "enter": "ENTRY",
    "react": "STEP"
  },

  "timeRules": [
    { "id": "time.non_zero_duration", "applies": "all", "severity": "error" },
    { "id": "time.no_step_overlap", "applies": "STEP", "severity": "error" },
    { "id": "time.parent_contains_children", "applies": "all", "severity": "error", "toleranceMs": 0 },
    { "id": "time.reasonable_duration", "applies": "LLM", "maxMs": 600000, "severity": "warn" },
    { "id": "time.chronological_steps", "applies": "STEP", "severity": "warn" }
  ],

  "semanticRules": [
    { "id": "semantic.agent_token_sum", "severity": "error" },
    { "id": "semantic.tool_matches_llm_output", "severity": "error", "requiresMessageContent": true },
    { "id": "semantic.entry_input_exists", "severity": "warn", "requiresMessageContent": true },
    { "id": "semantic.entry_output_matches", "severity": "warn", "requiresMessageContent": true },
    { "id": "semantic.consistent_session_id", "severity": "error" },
    { "id": "semantic.consistent_user_id", "severity": "error" },
    { "id": "semantic.consistent_agent_name", "severity": "warn" },
    { "id": "semantic.llm_has_input_output", "severity": "warn", "requiresMessageContent": true },
    { "id": "semantic.operation_kind_mapping", "severity": "error" },
    { "id": "semantic.span_name_pattern", "severity": "warn" }
  ],

  "resourceAttributes": {
    "must": [
      { "key": "service.name" }
    ],
    "should": [
      { "key": "acs.arms.service.feature", "expectedValue": "genai_app" }
    ]
  },

  "messageSchemas": {
    "input_messages": "$ref:specs/gen-ai-input-messages.json",
    "output_messages": "$ref:specs/gen-ai-output-messages.json"
  }
}
```

### 4.2 规则更新工具：`scripts/update-validation-rules.mjs`

```
用途: 从 GitLab 拉取最新 gen-ai.md，解析后生成/更新 trace-validation-rules.json

流程:
  1. 通过 GitLab API 获取 gen-ai.md 内容
  2. 解析 Markdown 中的属性表格 (| AttributeKey | ... | 需求等级 |)
  3. 按 span kind 分类提取"必须"→ must、"推荐/有条件时必须"→ should
  4. 获取 gen-ai_messages_schema/*.json 作为消息体 schema
  5. 合并生成 trace-validation-rules.json
  6. diff 对比旧版本，输出变更摘要

CLI:
  node scripts/update-validation-rules.mjs
    --spec-url https://code.alibaba-inc.com/...  (或 --spec-file 本地路径)
    --output docs/trace-validation-rules.json
```

---

## 5. 校验引擎

### 5.1 文件：`scripts/validate-trace.mjs`

```
输入:
  --input <path>     OTLP debug JSONL 文件路径（支持 glob）
  --latest           自动发现 ~/.loongsuite-pilot/logs/otlp-debug/ 下最新 JSONL 文件
  --rules <path>     校验规则文件路径（默认 docs/trace-validation-rules.json）
  --format json|text|summary  输出格式（默认 text）
  --output <path>    输出文件路径（可选，默认 stdout）
  --trace-id <id>    只校验指定 traceId（可选）
  --severity <level> 最低报告严重度: error|warn|info（默认 warn）

互斥: --input 和 --latest 必须指定其一

退出码:
  0 = 全部通过（无 error）
  1 = 存在 error
  2 = 输入错误（文件不存在等）
```

### 5.2 引擎执行流程

```
1. 读取 JSONL → 解析所有 span
2. 按 traceId 分组
3. 检测 captureMessageContent 状态（扫描是否有 gen_ai.input/output.messages）
4. 对每个 trace:
   a. 构建 span 树（parentSpanId 链接）
   b. 识别各 span 的 kind（从 gen_ai.span.kind 属性）
   c. 运行结构校验（§2.1）
   d. 运行属性校验（§2.2）— 公共属性 + 按 kind 属性
   e. 运行时间校验（§2.3）
   f. 运行格式校验（§2.4）— captureMessageContent=false 时相关规则 SKIPPED
   g. 运行语义校验（§2.5）— captureMessageContent=false 时相关规则 SKIPPED
5. 汇总结果 → 按 --format 输出报告
```

### 5.3 semantic.tool_matches_llm_output 校验细节

对每个 STEP 下的 LLM span 和 TOOL span 进行双向匹配：

```
匹配逻辑:
  1. 从 LLM span 的 gen_ai.output.messages 中提取所有 tool_call parts
     → 得到 expectedTools = [{ id, name }, ...]
  2. 从同级 TOOL span 中收集
     → 得到 actualTools = [{ callId: gen_ai.tool.call.id, name: gen_ai.tool.name }, ...]
  3. 正向匹配: 每个 actualTool 必须在 expectedTools 中找到对应
     → 优先用 callId 匹配 id，callId 缺失时退化为 name 匹配
  4. 反向匹配: 每个 expectedTool 必须有对应的 actualTool
     → 缺失的 TOOL span 报 ERROR

前置条件: captureMessageContent = true 且 LLM span 有 gen_ai.output.messages
否则: SKIPPED

已知豁免:
  - Subagent 调用（如 Claude Code 的 Agent tool_call）暂不建模为 TOOL span，
    当 LLM output 中的 tool_call name 为 subagent 类型时，降级为 WARN 而非 ERROR。
    已知 subagent tool 名称: "Agent"
```

### 5.4 输出报告格式

#### 格式 1：JSON（`--format json`）

```jsonc
{
  "meta": {
    "tool": "validate-trace",
    "version": "1.0",
    "rulesVersion": "1.0",
    "timestamp": "2026-06-04T16:00:00+08:00",
    "input": "fx-pilot-qoder-cli-2026-06-04.jsonl",
    "captureMessageContent": true
  },
  "summary": {
    "traces": 2,
    "spans": 28,
    "checks": { "total": 60, "pass": 55, "warn": 3, "error": 1, "skipped": 1 },
    "verdict": "FAIL"
  },
  "traces": [
    {
      "traceId": "d2d18ac20e3f...",
      "agent": "qoder-cli",
      "spans": 16,
      "structure": { "entry": 1, "agent": 1, "steps": 5, "llms": 5, "tools": 4 },
      "verdict": "PASS",
      "checks": [
        { "id": "structure.single_entry", "status": "pass" },
        { "id": "structure.step_has_one_llm", "status": "pass", "detail": "5 STEPs, each with 1 LLM" },
        { "id": "time.non_zero_duration", "status": "pass" },
        { "id": "semantic.agent_token_sum", "status": "pass", "detail": "input: 158212==158212, output: 4521==4521" },
        { "id": "semantic.tool_matches_llm_output", "status": "pass", "detail": "4 tools matched" },
        { "id": "attr.LLM.should.response_id", "status": "warn",
          "spanId": "abc123", "spanName": "chat qwen-plus", "detail": "missing gen_ai.response.id" }
      ]
    }
  ]
}
```

#### 格式 2：文本（`--format text`，默认）

```
╔══════════════════════════════════════════════════════════════╗
║  GenAI Trace Validation Report                              ║
║  Input: fx-pilot-qoder-cli-2026-06-04.jsonl                ║
║  Rules: trace-validation-rules.json v1.0                   ║
║  Message Content: enabled                                   ║
╚══════════════════════════════════════════════════════════════╝

Trace d2d18ac2... (qoder-cli, 16 spans)
  Structure: 1 ENTRY, 1 AGENT, 5 STEPs, 5 LLMs, 4 TOOLs
  ✅ structure.single_entry
  ✅ structure.step_has_one_llm (5 STEPs, each with 1 LLM)
  ✅ time.non_zero_duration
  ✅ time.no_step_overlap
  ✅ semantic.agent_token_sum (input: 158212==158212)
  ✅ semantic.tool_matches_llm_output (4 tools matched)
  ⚠️  attr.LLM.should.response_id — span abc123 missing gen_ai.response.id
  ⏭️  schema.input_messages — SKIPPED (captureMessageContent not enabled)

─────────────────────────────────────────────────

Summary: 2 traces, 28 spans
  ✅ Pass: 55  ⚠️ Warn: 3  ❌ Error: 1  ⏭️ Skipped: 1
  Verdict: FAIL
```

#### 格式 3：单行摘要（`--format summary`）

```
✅ 3 traces, 15 spans, 0 errors, 2 warnings, 0 skipped
```

或失败时：

```
❌ 2 traces, 28 spans, 1 error, 3 warnings, 1 skipped
```

---

## 6. Skill 包装层

### 6.1 文件结构

```
assets/skills/validate-trace/
  └── SKILL.md    — skill 定义 + 触发词 + 指令
```

### 6.2 Skill 行为

```
触发: /validate-trace [file-path]
  file-path 可选，默认使用 --latest 自动发现

行为:
  1. 确定待校验文件（参数 > --latest 自动发现今天最新的 otlp-debug/*.jsonl）
  2. 运行: node scripts/validate-trace.mjs --input <file> --format json
  3. 解析 JSON 报告
  4. 格式化展示:
     - 总览（traces/spans/pass/warn/error/skipped）
     - 按 trace 分组展示问题（只展示非 pass 的 checks）
     - 对 error 级别问题给出修复建议（结合代码上下文）
  5. 如有 SKIPPED 规则，提示用户可开启 captureMessageContent 获得完整校验

触发词: validate-trace, 验证trace, trace校验, genai校验, span校验,
        otlp校验, 本地trace验证, span规范校验
```

---

## 7. CI/E2E 集成

### 7.1 在 E2E 脚本中调用

```bash
# scripts/e2e/run-e2e.sh 中增加校验步骤
echo "==> Validating trace output..."
TRACE_FILES=$(ls ~/.loongsuite-pilot/logs/otlp-debug/*.jsonl 2>/dev/null)
if [ -n "$TRACE_FILES" ]; then
  node scripts/validate-trace.mjs \
    --input "$TRACE_FILES" \
    --rules docs/trace-validation-rules.json \
    --format text \
    --severity error
  if [ $? -ne 0 ]; then
    echo "❌ Trace validation failed"
    exit 1
  fi
  echo "✅ Trace validation passed"
fi
```

### 7.2 退出码语义

```
0 = 全部通过（零 error，可能有 warn 或 skipped）
1 = 存在 error（CI 应视为失败）
2 = 输入错误（文件不存在等）
```

---

## 8. 实施计划

```
Phase 1: 校验规则文件
  1.1 创建 docs/trace-validation-rules.json（从 gen-ai.md 手动提取）
  1.2 验证规则文件覆盖了所有 span kind 的 MUST/SHOULD 字段

Phase 2: 校验引擎
  2.1 创建 scripts/validate-trace.mjs 骨架（CLI 参数解析 + JSONL 读取 + --latest）
  2.2 实现结构校验（span 树构建 + 层级检查 + step_has_one_llm）
  2.3 实现属性校验（公共属性 + 按规则文件逐字段检查）
  2.4 实现时间校验（0ms / 重叠 / 严格包含 / 超长）
  2.5 实现格式校验（messages schema / token 类型+求和 / traceId 格式）
  2.6 实现语义校验（token 聚合 / tool-llm 匹配 / 一致性 / operation-kind 映射）
  2.7 实现 captureMessageContent 检测 + SKIPPED 机制
  2.8 实现报告输出（JSON + text + summary 三种格式）
  2.9 测试: 用真实 otlp-debug 数据验证

Phase 3: Skill 包装
  3.1 创建 assets/skills/validate-trace/SKILL.md
  3.2 测试: /validate-trace 触发 + 展示

Phase 4: 规则更新工具
  4.1 创建 scripts/update-validation-rules.mjs
  4.2 测试: 从 gen-ai.md 生成规则文件

Phase 5: CI 集成
  5.1 在 E2E 脚本中增加校验步骤
  5.2 测试: E2E 完整流程
```

---

## 9. 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `docs/trace-validation-rules.json` | 新建 | 结构化校验规则（从 gen-ai.md 提取） |
| `docs/trace-validation-design.md` | 已有 | 本设计文档 |
| `scripts/validate-trace.mjs` | 新建 | 校验引擎（核心，独立 CLI） |
| `scripts/update-validation-rules.mjs` | 新建 | 规则更新工具 |
| `assets/skills/validate-trace/SKILL.md` | 新建 | Claude Code skill 定义 |
| `specs/gen-ai-input-messages.json` | 已有 | 输入消息 JSON Schema |
| `specs/gen-ai-output-messages.json` | 已有 | 输出消息 JSON Schema |
