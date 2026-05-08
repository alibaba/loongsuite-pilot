## ADDED Requirements

### Requirement: Canonical Agent Activity Entry Fields

The system SHALL represent newly normalized agent activity events using the field names from section 3 of the current endpoint-side Agent schema, including OTel-style top-level fields and GenAI namespaced fields.

#### Scenario: Minimal canonical entry

- **WHEN** an input emits a minimal normalized agent activity event
- **THEN** the entry SHALL include `time_unix_nano`, `event.id`, `event.name`, `user.id`, `gen_ai.agent.type`, `gen_ai.provider.name`, and `gen_ai.session.id` when a session context exists

#### Scenario: Hierarchy fields use GenAI namespace

- **WHEN** an event includes session, turn, step, response, or tool-call hierarchy identifiers
- **THEN** the entry SHALL use `gen_ai.session.id`, `gen_ai.turn.id`, `gen_ai.step.id`, `gen_ai.response.id`, and `gen_ai.tool.call.id`

#### Scenario: Agent fields use GenAI namespace

- **WHEN** an event includes agent identity metadata
- **THEN** the entry SHALL use `gen_ai.agent.type`, `gen_ai.agent.id`, and `gen_ai.agent.name`

#### Scenario: Model and response fields use GenAI namespace

- **WHEN** an LLM request or response includes model or response metadata
- **THEN** the entry SHALL use `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, and `gen_ai.response.finish_reasons` instead of shortened model or response keys

#### Scenario: Usage fields use GenAI namespace

- **WHEN** token usage is available for an LLM event
- **THEN** the entry SHALL use `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, and `gen_ai.usage.total_tokens`

#### Scenario: Cost fields use GenAI usage namespace

- **WHEN** usage cost is available for an LLM event
- **THEN** the entry SHALL use `gen_ai.usage.input_cost`, `gen_ai.usage.output_cost`, `gen_ai.usage.cache_read.input_cost`, `gen_ai.usage.cache_creation.input_cost`, and `gen_ai.usage.total_cost`

#### Scenario: Tool fields use GenAI namespace

- **WHEN** a tool call or tool result event is normalized
- **THEN** the entry SHALL use `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.exec.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and `gen_ai.tool.call.duration`

#### Scenario: Event names use current enum

- **WHEN** an input normalizes an event type
- **THEN** the entry SHALL use one of `llm.request`, `llm.response`, `tool.call`, `tool.result`, `skill.use`, `tool.approve`, or `other`

### Requirement: Canonical Output Serialization

The system SHALL serialize only section-3 canonical fields for newly reported entries and SHALL NOT emit legacy shortened aliases as duplicate output columns.

#### Scenario: JSONL output uses canonical fields

- **WHEN** a normalized entry is written to JSONL output
- **THEN** the serialized record SHALL contain canonical keys such as `gen_ai.session.id`, `gen_ai.agent.type`, `gen_ai.provider.name`, and `gen_ai.usage.input_tokens`

#### Scenario: SLS output uses canonical fields

- **WHEN** a normalized entry is sent to SLS
- **THEN** the SLS log content SHALL contain canonical keys such as `gen_ai.request.model`, `gen_ai.usage.total_cost`, and `gen_ai.tool.call.arguments`

#### Scenario: Legacy aliases are omitted from new output

- **WHEN** an entry has both canonical fields and legacy aliases during migration
- **THEN** serialization SHALL omit legacy aliases such as `session.id`, `turn.id`, `step.id`, `agent.type`, `message.role`, `provider.name`, `request.id`, `request.model`, `response.model`, `usage.input_tokens`, `cost.total`, `input.messages`, `output.messages`, `tool.exec.id`, `tool.result.duration_ms`, `tool.arguments`, `tool.result.payload`, `gen_ai.message.role`, and `is_error`

### Requirement: Legacy Input Compatibility

The system SHALL continue reading existing local logs and hook records that use legacy shortened field names or source-specific raw field names.

#### Scenario: Legacy session, turn, step, agent, and model fields are accepted

- **WHEN** an input reads a record containing `session.id`, `turn.id`, `step.id`, `agent.type`, `message.role`, `request.model`, or `response.model`
- **THEN** the normalized entry SHALL populate `gen_ai.session.id`, `gen_ai.turn.id`, `gen_ai.step.id`, `gen_ai.agent.type`, `gen_ai.request.model`, and `gen_ai.response.model`, and SHALL omit `message.role`/`gen_ai.message.role` from canonical output

#### Scenario: Legacy usage fields are accepted

- **WHEN** an input reads a record containing `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_tokens`, or `usage.cache_write_tokens`
- **THEN** the normalized entry SHALL populate `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, and `gen_ai.usage.cache_creation.input_tokens`

#### Scenario: Legacy cost fields are accepted

- **WHEN** an input reads a record containing `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write`, or `cost.total`
- **THEN** the normalized entry SHALL populate `gen_ai.usage.input_cost`, `gen_ai.usage.output_cost`, `gen_ai.usage.cache_read.input_cost`, `gen_ai.usage.cache_creation.input_cost`, and `gen_ai.usage.total_cost`

#### Scenario: Legacy content fields are accepted

- **WHEN** an input reads a record containing `input.messages`, `input.messages_delta`, `output.messages`, `tool.arguments`, or `tool.result.payload`
- **THEN** the normalized entry SHALL populate the corresponding `gen_ai.input.messages`, `gen_ai.input.messages_delta`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, or `gen_ai.tool.call.result` field

#### Scenario: Source-specific raw fields are accepted

- **WHEN** an input reads Cursor, Qoder, Claude Code, Codex, or Qoder SQLite records with existing raw field names such as `session_id`, `conversation_id`, `model`, `tool_name`, `tool_input`, `tool_output`, or `token_info`
- **THEN** the normalized entry SHALL populate the canonical latest-schema fields without requiring the raw producer to change first

#### Scenario: Legacy miscellaneous event name is accepted

- **WHEN** an input reads a legacy record whose event name is `event`
- **THEN** the normalized entry SHALL populate `event.name` with `other`

### Requirement: Provider Name Inference

The system SHALL populate `gen_ai.provider.name` for normalized entries by preserving explicit provider values or inferring a low-cardinality provider value from model and source context.

#### Scenario: Explicit provider wins

- **WHEN** a raw record contains `gen_ai.provider.name` or a supported legacy provider alias
- **THEN** the normalized entry SHALL use that provider value without replacing it with an inferred value

#### Scenario: Provider inferred from model

- **WHEN** a raw record omits provider but includes a recognizable model name
- **THEN** the normalized entry SHALL infer `gen_ai.provider.name` using deterministic model-name rules such as Claude to `anthropic`, GPT to `openai`, Qwen to `qwen`, DeepSeek to `deepseek`, Gemini to `gcp.gemini`, and Grok to `x_ai`

#### Scenario: Provider inferred from source context

- **WHEN** a raw record omits provider and has no recognizable model name
- **THEN** the normalized entry SHALL infer provider from source context where reliable, such as Codex to `openai` and Qoder to `qwen`

#### Scenario: Unknown provider fallback

- **WHEN** neither explicit provider, model, nor source context identifies a provider
- **THEN** the normalized entry SHALL populate a stable low-cardinality fallback provider value

### Requirement: Event And Finish Reason Normalization

The system SHALL normalize event-name and finish-reason values to the current schema shapes before dispatching entries to flushers.

#### Scenario: Legacy event type maps to current event name

- **WHEN** a raw event type is `llm_call_input`, `llm_call_output`, `llm_call_thinking`, `tool_call_input`, `tool_call_output`, `skill_use`, or `other`
- **THEN** the normalized entry SHALL map it to the corresponding current `event.name`

#### Scenario: Tool approval event is represented

- **WHEN** a raw record represents user approval for tool execution
- **THEN** the normalized entry SHALL set `event.name` to `tool.approve`

#### Scenario: Tool failure uses error fields

- **WHEN** a raw tool result status indicates failure
- **THEN** the normalized entry SHALL use `error.type` and `error.message` rather than emitting `tool.result.status` or `is_error` as canonical output fields

#### Scenario: Finish reasons are arrays

- **WHEN** a raw LLM response contains a single finish reason string
- **THEN** the normalized entry SHALL set `gen_ai.response.finish_reasons` to a one-element string array

### Requirement: Sensitive Content Policy Uses Canonical Fields

The system SHALL apply sensitive content upload controls to section-3 canonical sensitive fields and SHALL also tolerate legacy aliases during migration.

#### Scenario: Upload disabled removes canonical sensitive fields

- **WHEN** content upload is disabled for an entry's `gen_ai.agent.type`
- **THEN** the system SHALL delete `gen_ai.input.messages`, `gen_ai.input.messages_delta`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result` before dispatch

#### Scenario: Policy lookup uses canonical agent type

- **WHEN** content upload policy is evaluated for a canonical entry
- **THEN** the system SHALL look up policy by `gen_ai.agent.type`

#### Scenario: Policy lookup accepts legacy agent type

- **WHEN** content upload policy is evaluated for a migration entry that only contains `agent.type`
- **THEN** the system SHALL still apply the policy for that agent type

#### Scenario: Upload disabled removes legacy sensitive aliases

- **WHEN** content upload is disabled and an entry still contains legacy sensitive aliases during migration
- **THEN** the system SHALL delete aliases such as `input.messages`, `input.messages_delta`, `output.messages`, `tool.arguments`, and `tool.result.payload` before dispatch

#### Scenario: Non-sensitive canonical metadata remains

- **WHEN** sensitive content fields are deleted
- **THEN** the system SHALL retain non-sensitive metadata such as event name, user ID, GenAI agent type, session ID, provider, model, usage, cost, timestamps, and error fields

