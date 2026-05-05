# Data Model: Cursor Hook Agent

**Feature**: `105-agent-cursor`  
**Date**: 2026-04-27

## 实体概览

```text
Cursor Hook Event (stdin JSON)
        |
        v
CursorHookRecord (raw payload)
        |
        +--> MappedStandardFields (normalized projection)
        |
        v
CursorHookOutputRecord (JSONL line)
        |
        v
CursorHookInputEntry (AgentActivityEntry)
        |
        v
SLS / output JSONL (via existing flushers)
```

## Entity: CursorHookRecord

原始输入 payload，来自 Cursor 各类 hook 事件。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `hook_event_name` / `hookEventName` | string | ❌ | 事件名称，缺失时归一化为 `unknown` |
| `session_id` / `conversation_id` | string | ❌ | 会话标识来源字段 |
| `generation_id` | string | ❌ | 对话轮次 ID |
| `model` / `response_model` | string | ❌ | 模型字段 |
| `tool_name` | string | ❌ | 工具名 |
| `tool_input` | object/string | ❌ | 工具参数，可为对象或 JSON 字符串 |
| `tool_output` / `result_json` / `tool_results` | object/string | ❌ | 工具结果候选字段 |
| `text` | string | ❌ | agent 输出文本（兜底映射） |
| `input_messages` / `output_messages` | object/string | ❌ | 消息数组字段，可为对象或 JSON 字符串 |
| `...` | unknown | ❌ | 其他未映射字段按保留策略进入 `data` |

**校验与约束**:
- 顶层必须为 JSON 对象；非对象或非法 JSON 直接 fail-open 返回 `{}`。
- 任意字段可缺失；映射过程采用可选透传与容错解析。

## Entity: MappedStandardFields

从 `CursorHookRecord` 派生的标准字段集合，用于跨事件统一分析。

| 字段 | 类型 | 说明 |
|---|---|---|
| `time_unix_nano` | string | 本地时间生成，纳秒字符串 |
| `event.name` | string | 由 hook 事件推导为 `llm.request`、`llm.response`、`tool.call`、`tool.result` 或 `event` |
| `session.id` | string | `session_id ?? conversation_id` |
| `turn.id` | string | 来自 `generation_id` |
| `request.model` | string | 来自 `model` |
| `response.model` | string | `response_model ?? model` |
| `message.role` | string | 由事件名推断（`user/tool/assistant`） |
| `usage.*` | number | token 与 cost 统计字段 |
| `input.messages_delta` / `input.messages` | array | LLM 请求消息增量与完整上下文 |
| `output.messages` | array | 模型输出消息，fallback 自 LLM 响应事件的 `text` |
| `tool.arguments` | object | 解析后的 `tool_input` |
| `tool.result` | object/string | 解析后的工具结果 |
| `...` | varies | 其他映射字段见 `research.md` 映射表 |

## Entity: CursorHookOutputRecord

单条 JSONL 输出记录，是最终落盘格式。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uuid` | string | ✅ | `crypto.randomUUID()` |
| `logTime` | string | ✅ | ISO-8601 UTC（秒级） |
| `reported` | boolean | ✅ | 初始为 `false` |
| `clientType` | string | ✅ | 固定 `CursorHook` |
| `hookEvent` | string | ✅ | 归一化后的事件名 |
| `data` | object | ✅ | `retainedRaw + mappedStandard` 合并结果 |

**合并规则**:
- 先保留未映射 raw 字段，再合并 mapped 字段。
- 若键冲突，mapped 值优先。
- 清理 `undefined` 及空对象/空数组。

## Entity: RetentionPolicy

日志文件保留策略（计划阶段定义，任务阶段实现）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `retentionDays` | number | `90` | 日志保留天数，可配置 |
| `cleanupMode` | enum | `deferred` | 本阶段仅定义策略，清理执行延后 |

## 状态转换与失败处理

```text
stdin empty / invalid json / runtime error
    -> emit "{}" -> exit 0

valid payload
    -> map fields -> append jsonl -> emit "{}" -> exit 0
```

说明：所有分支都遵循 fail-open，不阻塞调用方流程。

## Extension: Collector Input Integration

在扩展范围内，`src/inputs/cursor-hook/cursor-hook-input.ts` 会读取 `CursorHookOutputRecord`，转换为统一 `AgentActivityEntry` 后进入既有 `InputManager -> Flusher` 通路。

- 输入源 ID: `cursor-hook`
- 默认监听目录: `~/.loongsuite-pilot/logs/cursor-hook/history/`
- 默认输出目标: 复用已启用 flusher（如 SLS、JSONL）
