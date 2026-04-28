# Contract: Cursor Hook Input Payload

## Purpose

定义 `assets/hooks/cursor-hook.sh` 与 `assets/hooks/cursor-hook-processor.mjs` 接收的 stdin payload 契约。

## Input Channel

- Transport: `stdin`
- Format: UTF-8 JSON object (single payload per invocation)
- Non-blocking rule: invalid payload must not fail caller workflow

## Minimal Shape

```json
{
  "hook_event_name": "postToolUse"
}
```

## Common Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `hook_event_name` | string | No | Preferred event name field |
| `hookEventName` | string | No | Legacy/alternate event name |
| `session_id` | string | No | Preferred session identifier |
| `conversation_id` | string | No | Fallback session identifier |
| `generation_id` | string | No | Turn ID |
| `model` | string | No | Request model |
| `response_model` | string | No | Response model |
| `tool_name` | string | No | Tool name |
| `tool_input` | object/string | No | Tool args (object or JSON string) |
| `tool_output` | object/string | No | Tool output candidate |
| `result_json` | object/string | No | MCP output candidate |
| `text` | string | No | Assistant/thought fallback text |

## Event Coverage

Supported events:

- `preToolUse`, `postToolUse`, `postToolUseFailure`
- `beforeShellExecution`, `afterShellExecution`
- `beforeMCPExecution`, `afterMCPExecution`
- `beforeReadFile`, `afterFileEdit`, `beforeTabFileRead`, `afterTabFileEdit`
- `beforeSubmitPrompt`, `preCompact`
- `stop`, `sessionStart`, `sessionEnd`
- `subagentStart`, `subagentStop`
- `afterAgentResponse`, `afterAgentThought`

Event list source of truth: `specs/105-agent-cursor/spec.md` (`FR-007`).

## Validation Rules

1. Empty stdin -> return `{}` and exit success.
2. Non-JSON payload -> return `{}` and exit success.
3. JSON array / primitive root -> return `{}` and exit success.
4. Missing `hook_event_name` -> normalized as `unknown`.

## Backward Compatibility

- Fields may be object or stringified JSON.
- Unknown fields are preserved for output merge unless consumed by mapping rules.
