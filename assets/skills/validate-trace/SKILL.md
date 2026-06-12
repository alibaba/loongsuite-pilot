---
name: validate-trace
description: >
  按照 ARMS GenAI 语义规范校验 pilot 在 otlp-debug 下输出的 trace 数据。
  覆盖结构完整性、属性完整性、时间范围、数据格式、语义一致性五个维度。
  触发词：validate-trace, 验证trace, trace校验, genai校验, span校验,
  otlp校验, 本地trace验证, span规范校验, 校验span, 校验trace数据。
---

# GenAI Trace 规范校验

通过 `scripts/validate-trace.mjs` 校验 pilot 产出的 otlp-debug JSONL 数据是否符合 ARMS GenAI 语义规范。

## 触发方式

```
/validate-trace              → 自动发现最新 JSONL 文件并校验
/validate-trace <file-path>  → 校验指定文件
```

## 执行流程

### 1. 确定待校验文件

- 有参数时：使用用户指定的文件路径
- 无参数时：使用 `--latest` 自动发现 `~/.loongsuite-pilot/logs/otlp-debug/` 下最新的 JSONL 文件

如果 otlp-debug 目录不存在或无 JSONL 文件，提示用户在 `~/.loongsuite-pilot/config.json` 中开启 `cms.debug: true`，然后触发一次 agent 交互生成数据。

### 2. 运行校验引擎

```bash
node scripts/validate-trace.mjs --latest --format json --output /tmp/validate-trace-report.json
```

或指定文件：

```bash
node scripts/validate-trace.mjs --input <file-path> --format json --output /tmp/validate-trace-report.json
```

### 3. 解析报告并展示

读取 JSON 报告，按以下格式向用户展示：

#### 总览

展示 `summary` 中的总计信息：

```
校验结果：<PASS|FAIL>
  Traces: N  |  Spans: M
  Pass: X  |  Warn: Y  |  Error: Z  |  Skipped: W
  Message Content: <enabled|disabled>
```

#### 问题列表

只展示 `status` 不是 `pass` 的 checks，按 trace 分组：

```
Trace <traceId前12位>... (<agent>, <spans> spans)
  ❌ <rule-id> — <detail> [span: <spanId前8位>]
  ⚠️  <rule-id> — <detail>
  ⏭️  <rule-id> — SKIPPED (<reason>)
```

如果所有 trace 都 PASS，展示简短成功消息。

#### 修复建议

对每个 ERROR 级别问题，结合代码上下文给出修复方向：

| 常见 ERROR | 可能原因 | 修复方向 |
|---|---|---|
| `structure.single_entry` | TraceInput 未生成 ENTRY span | 检查 `createEntrySpan()` 调用 |
| `structure.step_has_one_llm` | 某 STEP 内 LLM span 丢失或多余 | 检查 `createStepSpan()` 和 LLM span 的 parent 设置 |
| `time.parent_contains_children` | 子 span 时间超出父 span 范围 | 时钟源不一致，参考 `docs/trace-input-development-guide.md` 中时钟源章节 |
| `time.non_zero_duration` | span 时长为 0 | 开始/结束时间戳相同，检查事件时间提取逻辑 |
| `semantic.agent_token_sum` | AGENT token 与 LLM 汇总不匹配 | 检查 `finalizeTrace()` 中 token 聚合逻辑 |
| `semantic.tool_matches_llm_output` | TOOL span 与 LLM output 的 tool_call 不对应 | 检查 tool span 的 `gen_ai.tool.call.id` 和 `gen_ai.tool.name` |
| `attr.*.must.*` | 必须属性缺失 | 检查对应 span 的 attributes 设置 |
| `schema.tokens_sum` | total != input + output | 检查 token 赋值逻辑 |

#### SKIPPED 提示

如果有 SKIPPED 规则，告知用户：

> 部分校验规则因 `captureMessageContent` 未开启而被跳过。
> 如需完整校验，在 `~/.loongsuite-pilot/config.json` 中设置 `otlpTrace.captureMessageContent: true`。

### 4. 可选的深入分析

如果用户希望深入某个失败的 trace，可以：

```bash
node scripts/validate-trace.mjs --latest --format text --trace-id <traceId>
```

展示该 trace 的全部校验细节。

## 校验维度概览

| 维度 | 说明 | 严重度 |
|---|---|---|
| **结构** | trace 树完整性（ENTRY/AGENT/STEP/LLM/TOOL 层级） | ERROR |
| **属性** | 按 span kind 校验 MUST/SHOULD 属性存在性和值 | ERROR/WARN |
| **时间** | 零时长、重叠、父包含子、超长 | ERROR/WARN |
| **格式** | token 类型、messages JSON Schema、traceId/spanId 格式 | ERROR/WARN |
| **语义** | token 聚合一致性、tool-LLM 对应、session/user 一致 | ERROR/WARN |

## 规范来源

- 规则文件：`docs/trace-validation-rules.json`
- ARMS GenAI 语义规范：`docs/ai_event_schema.md`
- 消息体 JSON Schema：`tests/schemas/gen-ai-*.json`
- 设计文档：`docs/trace-validation-design.md`
