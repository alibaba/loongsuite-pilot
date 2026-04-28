# Cursor Hook Mapping Research

## Decision

将 Cursor hook raw payload 到标准字段的映射细则维护在本文件，并作为 `assets/hooks/cursor-hook-processor.mjs` 的映射事实来源。

## Rationale

- `spec.md` 应保持用户价值和验收标准导向，不承载大量实现细节。
- 映射表、字段清理集合与冲突策略属于实现契约，适合放在研究/设计文档中持续维护。
- 将映射表独立后，后续新增事件字段时可单独更新，不破坏规格文档可读性。

## Alternatives Considered

- 将完整映射表直接保留在 `spec.md`：可读性差，且偏离 spec-kit 的规范意图。
- 仅在代码中维护映射：缺乏跨角色可审阅的设计文档，不利于评审和回归核对。

## Additional Planning Decisions

### Decision: 默认完整保留正文类原始字段

**Decision**: 对 `text`、`tool_output`、`input_messages` 等正文类原始字段默认完整保留，不在采集侧自动脱敏或裁剪。

**Rationale**:
- 与 `spec.md` 的澄清结论一致，避免采集层提前丢失可能有价值的调试信息。
- 脱敏策略应由下游存储策略或后续合规 feature 管理，避免在当前实现阶段引入复杂分支。

**Alternatives considered**:
- 默认脱敏：会降低敏感信息风险，但当前需求未要求，且会影响排障与语义完整性。
- 仅保留元数据：最安全，但无法满足当前映射核对和行为审计需求。

### Decision: 保留周期可配置，默认 90 天

**Decision**: 引入 retention policy 概念，保留天数可配置，默认值为 90 天；具体清理执行方式在任务阶段实现。

**Rationale**:
- 满足规格澄清后的可运维性需求，避免无限制增长。
- 将“策略定义”和“清理实现”拆分，降低本阶段设计复杂度。

**Alternatives considered**:
- 永久保留：实现最简单但存在容量和合规风险。
- 固定 30 天自动清理：约束过强，难适配不同用户场景。

## Mapping Table (Raw -> Standard)

| Standard field | Cursor source field(s) | Mapping rule |
| --- | --- | --- |
| `timestamp_ns` | none | Generated from local time |
| `trace_id` | `trace_id` | Pass-through when present |
| `span_id` | `span_id` | Pass-through when present |
| `gen_ai.session_id` | `session_id`, `conversation_id` | `session_id ?? conversation_id` |
| `gen_ai.turn_id` | `generation_id` | Pass-through when present |
| `gen_ai.step_id` | `step_id` | Pass-through when present |
| `gen_ai.response_id` | `response_id` | Pass-through when present |
| `gen_ai.agent_id` | `subagent_id`, `agent_id` | `subagent_id ?? agent_id` |
| `gen_ai.agent_name` | `subagent_name`, `agent_name`, `subagent_id` | `subagent_name ?? agent_name ?? subagent_id` |
| `gen_ai.provider_name` | `provider_name` | Pass-through when present |
| `gen_ai.request_model` | `model` | Pass-through when present |
| `gen_ai.response_model` | `response_model`, `model` | `response_model ?? model` |
| `gen_ai.error_type` | `failure_type`, `error_type` | `failure_type ?? error_type` |
| `gen_ai.error_message` | `error_message` | Pass-through when present |
| `gen_ai.response_finish_reasons` | `response_finish_reasons` | Pass-through when present |
| `gen_ai.input_tokens` | `input_tokens` | Pass-through when present |
| `gen_ai.output_tokens` | `output_tokens` | Pass-through when present |
| `gen_ai.cache_write_tokens` | `cache_write_tokens` | Pass-through when present |
| `gen_ai.cache_read_tokens` | `cache_read_tokens` | Pass-through when present |
| `gen_ai.role` | `hook_event_name` | Inferred by event name (`before*readfile`/`beforeSubmitPrompt`/`preToolUse`/`beforeShellExecution`/`beforeMCPExecution` -> `user`, `postToolUse*`/`afterShellExecution`/`afterMCPExecution` -> `tool`, `subagent*`/`afterAgentThought`/`afterAgentResponse` -> `assistant`) |
| `gen_ai.input_messages_hash` | `input_messages_hash`, `input_messages` | Prefer `input_messages_hash`, fallback SHA-256 of `input_messages` |
| `gen_ai.input_messages_delta` | `input_messages_delta` | Parse JSON string or object |
| `gen_ai.input_messages` | `input_messages` | Parse JSON string or object |
| `gen_ai.output_messages` | `output_messages`, `text`, `hook_event_name` | Prefer `output_messages`; fallback from `text` to message array |
| `gen_ai.tool_name` | `tool_name` | Pass-through when present |
| `gen_ai.tool_arguments` | `tool_input` | Parse JSON string or object |
| `gen_ai.tool_results` | `tool_output`, `result_json`, `tool_results` | `tool_output ?? result_json ?? tool_results`, then parse |
| `gen_ai.tool_call_id` | `tool_use_id` | Pass-through when present |

## Source Field Pruning

Mapped source fields are removed from output `data` after mapping:

- `hook_event_name`, `hookEventName`
- `conversation_id`, `generation_id`, `session_id`
- `trace_id`, `span_id`, `step_id`, `response_id`
- `subagent_id`, `agent_id`, `subagent_name`, `agent_name`
- `provider_name`, `model`, `response_model`
- `failure_type`, `error_type`, `error_message`
- `response_finish_reasons`
- `input_tokens`, `output_tokens`, `cache_write_tokens`, `cache_read_tokens`
- `input_messages_hash`, `input_messages_delta`, `input_messages`, `output_messages`, `text`
- `tool_name`, `tool_input`, `tool_output`, `result_json`, `tool_results`, `tool_use_id`

## Merge and Conflict Policy

- Keep non-mapped raw fields in `data`.
- Append mapped standard fields into `data`.
- If retained raw key conflicts with mapped standard key, mapped value wins.
- Remove `undefined` values and empty objects/arrays.

## Fail-Open Processing Policy

- Empty stdin: return `{}` and exit success.
- Invalid JSON payload: return `{}` and exit success.
- Runtime/append failure: return `{}` and exit success.
- Supported event processing success: return `{}`.

## Event Coverage Sync Rule

- 事件覆盖以 `spec.md` 的 `FR-007` 为源定义。
- `contracts/cursor-hook-input.md` 的 Supported events 列表必须与 `FR-007` 保持一致。
- 每次新增/移除事件时，需同步更新以下文件并做一次回归核验：
  - `specs/105-agent-cursor/spec.md`
  - `specs/105-agent-cursor/contracts/cursor-hook-input.md`
  - `specs/105-agent-cursor/quickstart.md`
  - 本机 Cursor hook 配置文件（项目级或用户级，如 `.cursor/hooks.json`）
