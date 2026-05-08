## Context

The collector currently normalizes all input records into `AgentActivityEntry` before user enrichment, sensitive-content policy application, and flusher output. That boundary is already the right place to keep reporting fields consistent, but the current contract uses a mix of OTel-style top-level fields and shortened Agent/GenAI names:

- identity and hierarchy fields such as `session.id` and `response.id`;
- model/provider fields such as `provider.name`, `request.model`, and `response.model`;
- agent fields such as `agent.type`, `agent.id`, and `agent.name`;
- usage and cost fields such as `usage.input_tokens`, `usage.cache_write_tokens`, and `cost.total`;
- sensitive JSON fields such as `input.messages`, `output.messages`, `tool.arguments`, and `tool.result.payload`.

The current endpoint-side Agent schema in `端侧 Agent 支持情况 (1).md`, especially section 3, makes `gen_ai.*` names canonical for session, turn, step, agent, provider, request, response, usage, cost, tool, and skill fields. It keeps OTel-style top-level fields such as `time_unix_nano`, `observed_time_unix_nano`, `trace_id`, `span_id`, `event.*`, `host.*`, `error.*`, `user.id`, and `service.name`.

The main constraint is local compatibility. Existing hook processors and already-written JSONL files may still contain old shortened keys, and the collector must keep reading them without data loss.

## Goals / Non-Goals

**Goals:**

- Make `AgentActivityEntry` match section 3 of the current endpoint-side Agent schema for all newly emitted collector output.
- Keep old local logs readable by accepting both latest schema keys and known legacy aliases in input transforms.
- Infer `gen_ai.provider.name` when raw data omits it, using model name first and source/agent context as fallback.
- Normalize `event.name` to the current enum, including `tool.approve` and `other`.
- Keep sensitive-content policy behavior consistent across JSONL, SLS, and HTTP outputs after field renaming.
- Update tests so contract coverage protects both canonical output and legacy input compatibility.

**Non-Goals:**

- Rewriting already persisted historical output files.
- Changing raw hook processor storage format beyond what is needed for compatibility.
- Adding a full provider registry, remote model metadata lookup, or external dependency.
- Adding semantic PII detection or masking beyond the existing upload/delete policy.
- Preserving old shortened field names in newly serialized flusher output.

## Decisions

### Decision 1: Canonical Internal Shape Uses Section 3 Field Names

`AgentActivityEntry` should use the field names from section 3 directly, not a second internal DTO followed by an output projection. Inputs, policies, and flushers already share this type as the collector's normalization contract, so keeping one canonical shape avoids another mapping layer.

Important renames:

- `session.id` -> `gen_ai.session.id`
- `turn.id` -> `gen_ai.turn.id`
- `step.id` -> `gen_ai.step.id`
- `response.id` and old `request_id` response aliases -> `gen_ai.response.id` where they identify a provider response
- `agent.type` -> `gen_ai.agent.type`
- `agent.id` -> `gen_ai.agent.id`
- `agent.name` -> `gen_ai.agent.name`
- `provider.name` -> `gen_ai.provider.name`
- `request.id` -> `gen_ai.request.id`
- `request.model` -> `gen_ai.request.model`
- `response.model` -> `gen_ai.response.model`
- `response.finish_reasons` -> `gen_ai.response.finish_reasons`
- `usage.input_tokens` -> `gen_ai.usage.input_tokens`
- `usage.output_tokens` -> `gen_ai.usage.output_tokens`
- `usage.cache_read_tokens` -> `gen_ai.usage.cache_read.input_tokens`
- `usage.cache_write_tokens` -> `gen_ai.usage.cache_creation.input_tokens`
- `usage.total_tokens` -> `gen_ai.usage.total_tokens`
- `cost.input` -> `gen_ai.usage.input_cost`
- `cost.output` -> `gen_ai.usage.output_cost`
- `cost.cache_read` -> `gen_ai.usage.cache_read.input_cost`
- `cost.cache_write` -> `gen_ai.usage.cache_creation.input_cost`
- `cost.total` -> `gen_ai.usage.total_cost`
- `input.messages`, `input.messages_delta`, and `input.messages_hash` -> `gen_ai.input.messages`, `gen_ai.input.messages_delta`, and `gen_ai.input.messages_hash`
- `output.messages` -> `gen_ai.output.messages`
- `tool.name` -> `gen_ai.tool.name`
- `tool.call.id` remains `gen_ai.tool.call.id`
- `tool.exec.id` -> `gen_ai.tool.call.exec.id`
- `tool.arguments` -> `gen_ai.tool.call.arguments`
- `tool.result.payload` -> `gen_ai.tool.call.result`
- `tool.result.duration_ms` -> `gen_ai.tool.call.duration_ms`
- `skill.name` -> `gen_ai.skill.name`
- `attributes` should be replaced for new output by structured canonical fields where available, with non-standard temporary extension data kept under `agent.xxx` only when needed.

Alternative considered: keep the current short internal field names and only rename inside flushers. Rejected because content policy, contract tests, and future inputs would still reason about the old schema, making the migration incomplete.

### Decision 2: Inputs Accept Legacy Aliases, Outputs Serialize Canonical Fields

Input transforms should use helper functions that read canonical keys first and then old aliases. For example:

- session: `gen_ai.session.id`, then `session.id`, then raw `session_id`/`conversation_id`;
- turn/step: `gen_ai.turn.id`/`gen_ai.step.id`, then `turn.id`/`step.id`, then raw `turn_id`/`gen_ai.turn_id` and `gen_ai.step_id`;
- agent: `gen_ai.agent.type`, then `agent.type`;
- model: `gen_ai.request.model`, then `request.model`, then raw `model`;
- request id: `gen_ai.request.id`, then `request.id`;
- tool result: `gen_ai.tool.call.result`, then `tool.result.payload`, then `tool.result`/raw output fields.

`buildAgentActivityEntry()` may accept legacy option names for in-repo callers during migration, but it should build canonical fields. `serialiseLogEntry()` should omit legacy alias fields from new output.

Alternative considered: add both old and new names to every emitted entry for a transition period. Rejected because downstream SLS wide-table semantics would receive duplicate columns with unclear precedence, and the latest schema is intended to be the reporting contract.

### Decision 3: Provider Inference Is a Normalization Helper

`gen_ai.provider.name` is required by the latest schema, but several sources only expose a model string or no model at all. Add a deterministic `inferProviderName()` helper used by input transforms or `buildAgentActivityEntry()`.

Initial inference rules:

- explicit `gen_ai.provider.name` or legacy `provider.name` wins;
- model names containing or starting with Claude/Anthropic forms -> `anthropic`;
- GPT/OpenAI model forms -> `openai`;
- Qwen/Tongyi forms -> `qwen`;
- DeepSeek forms -> `deepseek`;
- Gemini forms -> `gcp.gemini`;
- Grok/xAI forms -> `x_ai`;
- Codex source without stronger evidence -> `openai`;
- Qoder source without stronger evidence -> `qwen`;
- otherwise use a low-cardinality fallback such as `unknown`.

The fallback should be consistent and documented so downstream analytics can filter unknowns.

Alternative considered: fail validation when provider is absent. Rejected because current local sources are best-effort collectors and should continue fail-open.

### Decision 4: Event Name Normalization Happens Before Dispatch

`event.name` should use the current enum from the endpoint-side schema: `llm.request`, `llm.response`, `tool.call`, `tool.result`, `skill.use`, `tool.approve`, and `other`. Existing inputs that currently emit `event` for miscellaneous records should emit `other` in new output. Legacy raw values such as old `event_type`, `llm_call_input`, `tool_call_output`, and previous `event` should be accepted and mapped before dispatch.

Tool execution outcome is no longer a canonical `tool.result.status` field in section 3. Successful results are represented by `gen_ai.tool.call.result`; failures are represented by `error.type` and `error.message`. If a raw status is still useful, keep it as extension data rather than a stable output column.

Alternative considered: keep `tool.result.status` for backwards-compatible querying. Rejected because section 3 does not define it as a canonical field.

### Decision 5: Sensitive Field Sets Include New Names and Legacy Aliases

The upload policy should delete canonical sensitive fields:

- `gen_ai.input.messages`
- `gen_ai.input.messages_delta`
- `gen_ai.output.messages`
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`

During migration it should also delete legacy aliases if a transform or old caller still supplies them. This keeps the policy fail-safe while implementation is converted file by file.

Alternative considered: only update the policy after all inputs are converted. Rejected because partial migration could accidentally leave content fields under legacy names.

## Risks / Trade-offs

- Breaking downstream field names -> Document the break in the proposal and update contract tests so the change is deliberate.
- Provider inference may be imperfect -> Use low-cardinality deterministic rules and keep explicit provider values authoritative.
- Legacy aliases could linger in code -> Add tests asserting serialized output does not include old shortened fields for canonical entries.
- Existing local historical JSONL remains old-shaped -> Keep input transforms compatible with old keys; do not attempt in-place file migration.
- `gen_ai.response.finish_reasons` changes from a string to `string[]` -> Normalize single raw strings into one-element arrays.
- Existing dashboards may query `agent.type`, `cost.*`, or `tool.result.*` -> Mark this change as breaking and update local tests/fixtures to catch stale consumers.

## Migration Plan

1. Update the type contract and schema tests to represent the latest field names.
2. Add shared alias-reading, provider inference, event-name normalization, and finish-reason normalization helpers.
3. Convert `buildAgentActivityEntry()` to produce canonical entries from both standard and legacy options.
4. Convert content policy and endpoint redaction to delete canonical sensitive fields plus old aliases.
5. Convert each input transform to emit canonical fields while reading old local log keys.
6. Update unit/integration tests and fixtures to verify canonical output and legacy input compatibility.
7. Run the test suite for normalization, inputs, and flusher serialization.

Rollback is code-level only: revert the change if downstream systems are not ready for the canonical field names. Historical local logs remain readable because they are not rewritten.

## Open Questions

- Should the provider fallback string be exactly `unknown`, or should unknown self-hosted/local models use a custom provider namespace such as `loongsuite.unknown`? The current design assumes `unknown` for low-cardinality filtering unless product requirements choose otherwise.

