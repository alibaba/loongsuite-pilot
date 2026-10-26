# Output Event Schema

English | [简体中文](zh-CN/output-event-schema.md)

LoongSuite Pilot normalizes collected activity into GenAI telemetry events. The current Pilot output format is a variant of GenAI audit events. Sensitive content fields are opt-in and can be masked before output.

The types below describe normalized semantic values. JSONL preserves native JSON
types; string-only backends such as SLS may serialize values at their own output
boundary.

## Hermes / OpenClaw source JSONL timing

Hermes allocates a stable per-request `span_id` and synchronously appends
`llm.request` to `logs/hermes-agent/*.jsonl` at `pre_api_request`. Its response
reuses that ID. Responses, tool calls and tool results append when their hooks
provide the data. Turn completion fills missing legacy response content and
appends a terminal marker without repeating successfully written events.
Unfinished requests remain visible without a fabricated successful response.
TTFT observation supports both the legacy method and the newer lazy streaming helper.

Incremental records carry `agent.hermes.collection=realtime-v1`.
Before the first `llm.request` is appended, the plugin appends one user-input
`other` event with `agent.hermes.hook=turn_start` for per-turn upstream trace
linking. It uses the resolved native turn/task ID and the observed first API
request start time, and carries no token usage. The terminal
record carries `event.name=other`, `agent.hermes.hook=turn_end` and
`gen_ai.turn.end=true`. The collector uses this explicit boundary so retries and
overlapping turns in one session do not truncate a trace. Legacy records retain
their existing boundary detection. Source appends do not wait for trace export.

The modern OpenClaw plugin allocates a model SpanID at `model_call_started` and
reuses it for the response. Child events awaiting parent context still use bounded
buffering to preserve trace relationships. Tool events subject to interception
also wait for policy decisions.

Cross-process visibility after append does not require per-event `fsync`. This
contract concerns the source plugin file, not normalized `logs/output` or remote
SLS/ARMS visibility. A context consumer must run **after** Pilot's request hook and
**before** network send, matching `gen_ai.session.id` and `gen_ai.turn.id`, plus
Hermes `gen_ai.request.id` or OpenClaw `gen_ai.step.id` (the model call ID), for
**each** API request. A one-time `pre_llm_call` stash runs
before request allocation; selecting the globally latest line is unsafe across
requests and sessions. Tool outbound requests should use the matching `tool.call`
context rather than reuse one LLM SpanID for all outbound operations in a turn.

Deploy the incremental Hermes plugin and its matching collector together; older
collectors do not understand the new explicit turn-completion protocol.

## Event Names

| `event.name` | Description |
|--------------|-------------|
| `llm.request` | One LLM request, including user input, context delta, and requested model. Message role is represented in message payloads. |
| `llm.response` | One LLM response, including text, reasoning, tool-call intent, finish reason, token usage, and cost when available. |
| `tool.call` | An actual tool execution started by the agent. |
| `tool.result` | The result returned by a tool execution. |
| `gen_ai.model.request` / `gen_ai.model.response` | Standard model event names; accepted alongside the legacy short names and preserved in logs. |
| `gen_ai.tool.call` / `gen_ai.tool.result` | Standard tool event names; accepted alongside the legacy short names and preserved in logs. |
| `gen_ai.agent.invoke` | One logical delegation to another Agent; one event per work item in a batch. |
| `gen_ai.agent.result` | An observed Agent result or failed dispatch. Tool acceptance alone is not Agent completion. |
| `skill.use` | A skill, extension, or agent capability invocation. |
| `tool.approve` | A user approval event for a tool or action. |
| `agent.input` | A compatibility copy of an input-bearing `other`, for querying Agent input by event name. |
| `other` | Other events that cannot be classified into the above event names. |

During the compatibility period, an `other` carrying `gen_ai.input.messages` or
`gen_ai.input.messages_delta` is preserved and followed by one `agent.input`.
The compatibility copy preserves the input content and context, but has a
deterministically derived `event.id` and omits `gen_ai.turn.start` and
`gen_ai.turn.end`; the legacy `other` remains the sole owner of Turn boundaries.
Expansion runs after masking, so both events carry the same masked content.
Records without canonical input fields do not generate `agent.input`. SLS, JSONL, and HTTP retain both
events when a copy is generated. OTLP Trace conversion continues to consume the
legacy `other` and excludes the compatibility copy, so the Span tree does not
gain an empty STEP.

The four core `event.name` values map to GenAI audit events as follows:

| Pilot `event.name` | GenAI audit-event `event.name` |
|--------------------|--------------------------------|
| `llm.request` | `gen_ai.model.request` |
| `llm.response` | `gen_ai.model.response` |
| `tool.call` | `gen_ai.tool.call` |
| `tool.result` | `gen_ai.tool.result` |

All six standard names are recognized without falling back to `other`. Existing
short-name output is preserved, without automatically duplicating events under
both names. The trace boundary adapts model/tool names and excludes Agent audit
events from span construction to avoid duplicate spans, steps and usage.

Codex children retain their own session/turn/step identities. Parent invoke/result
events carry `gen_ai.agent.invocation.id`; the corresponding child work carries
the equal `gen_ai.agent.parent.invocation.id`. New work in a reused session gets
a new invocation; nested delegations retain both incoming and outgoing IDs.
See the [subagent data model](zh-CN/subagent-data-model.md).

## Field Reference

Required levels follow OpenTelemetry wording:

- `Required` - always provided.
- `Conditionally Required` - provided when the condition applies.
- `Recommended` - provided when the source agent exposes the data.
- `When available` - reported whenever the integration provides the field.
- `Opt-In` - requires an independently enabled feature, such as multimodal upload.

| Field | Type | Required Level | Description |
|-------|------|----------------|-------------|
| `time_unix_nano` | uint64 | Required | Semantic event time as Unix nanoseconds. For paired spans this is the actual request/response or call/result boundary, not collection time. |
| `observed_time_unix_nano` | uint64 | Recommended | Time when the collector observed the event, as Unix nanoseconds. It may differ from the source event time. |
| `event.id` | string | Required | Globally unique event ID generated by the collector. |
| `event.name` | string | Required | Event name. See [Event Names](#event-names). |
| `user.id` | string | Required | User identity, such as an employee ID, local account, or machine-level identity. |
| `user.name` | string | Recommended when exposed by the source agent | Short name or login of the agent account. Qoder IDE uses the Stop hook's `extra.user.name`; Qoder CLI uses `username` from `qodercli status`. |
| `user.email` | string | Recommended when exposed by the source agent | Agent account email. Qoder IDE uses the Stop hook's `extra.user.email`; Qoder CLI uses `email` from `qodercli status`. A missing, logged-out, or failed CLI lookup omits both fields. |
| `trace_id` | string | Recommended | W3C Trace ID, used to correlate a full request chain across systems. |
| `span_id` | string | Recommended | Current Span ID. |
| `parent_span_id` | string | Recommended | Parent Span ID. Empty for root spans. |
| `host.name` | string | Recommended | Hostname, pod name, or machine name where the agent runs. |
| `host.ip` | string | Recommended | Host IP or log source IP. |
| `service.name` | string | Recommended | Service name used to distinguish agent instances or product lines. |
| `gen_ai.session.id` | string | Conditionally Required when the agent maintains session context | User session or conversation ID. |
| `agent.openclaw.session_key` | string | Recommended when exposed by OpenClaw | Native logical routing key; distinct from the conversation UUID in `gen_ai.session.id`. Preserved in canonical event logs and OpenClaw ENTRY/AGENT/STEP/LLM/TOOL Span attributes (not Resources) when the run has an unambiguous native key. |
| `gen_ai.turn.id` | string | Recommended | One user request through the agent's final response. |
| `gen_ai.step.id` | string | Recommended | One ReAct loop or intermediate agent step. |
| `gen_ai.response.id` | string | Recommended | LLM response ID returned by the model provider when available. |
| `gen_ai.agent.type` | string | Required | Agent product type, such as `claude-code`, `codex`, `cursor`, `qoder`, or `qoder-work`. |
| `gen_ai.agent.id` | string | Recommended | Unique runtime instance ID for the agent. |
| `gen_ai.agent.parent.id` | string | Recommended when known | Upstream Agent identity for this work; does not replace invocation correlation. |
| `gen_ai.agent.peer.id` | string | Recommended when known | Direct peer in an invoke/result event. |
| `gen_ai.agent.invocation.id` | string | Required on delegation events | Stable outgoing work ID, unique per delegated work item. |
| `gen_ai.agent.parent.invocation.id` | string | Required on confirmed incoming work | Upstream delegation accepted by this event/turn, not a permanent session property. |
| `gen_ai.agent.name` | string | Recommended | Human-readable agent instance name. |
| `gen_ai.provider.name` | string | Required | Model provider name. See [Provider Names](#provider-names). |
| `gen_ai.request.id` | string | Recommended | Client-side request ID used to correlate with gateway or provider logs. |
| `gen_ai.request.model` | string | Conditionally Required when available | Model requested by the client. |
| `gen_ai.response.model` | string | Recommended | Actual model used for the response. |
| `gen_ai.response.finish_reasons` | string[] | Recommended | Reasons why generation stopped. See [Finish Reasons](#finish-reasons). |
| `gen_ai.response.time_to_first_token` | int | Recommended when available | Time from the native model request boundary to the first generated reasoning, text, or tool-call output, in nanoseconds. Omit it when either boundary is unavailable or invalid. |
| `gen_ai.usage.input_tokens` | int | Recommended | Input tokens consumed by the request. |
| `gen_ai.usage.output_tokens` | int | Recommended | Output tokens generated by the response. |
| `gen_ai.usage.cache_read.input_tokens` | int | Recommended | Input tokens read from provider cache. Included in `gen_ai.usage.input_tokens`. |
| `gen_ai.usage.cache_creation.input_tokens` | int | Recommended | Input tokens written to provider cache. Included in `gen_ai.usage.input_tokens`. |
| `gen_ai.usage.total_tokens` | int | Recommended | Total tokens for the interaction. |
| `gen_ai.usage.input_cost` | double | Recommended | Input token cost in USD when pricing data is available. |
| `gen_ai.usage.output_cost` | double | Recommended | Output token cost in USD when pricing data is available. |
| `gen_ai.usage.cache_read.input_cost` | double | Recommended | Cache-read token cost in USD. |
| `gen_ai.usage.cache_creation.input_cost` | double | Recommended | Cache-creation token cost in USD. |
| `gen_ai.usage.total_cost` | double | Recommended | Total event cost in USD. |
| `gen_ai.input.messages` | json array | When available | Full messages sent to the model. May contain sensitive content. With multimodal enabled, images appear as `uri` parts instead of base64. |
| `gen_ai.input.messages_delta` | json array | Recommended | Newly added input message fragments compared with the previous `llm.request`. |
| `gen_ai.input.messages_hash` | string | Recommended | Hash of the full input context for deduplication and cache analysis. |
| `gen_ai.input.multimodal_metadata` | json array | Opt-In | Summary of `uri` media on input and tool output; items include `uri`, `mime_type`, and optional `modality`. Written when multimodal is enabled and those surfaces contain media. |
| `gen_ai.input.multimodal_metadata_delta` | json array | Opt-In | Summary of `uri` media on this event's `messages_delta` and `tool.call.result`. Same item shape as `gen_ai.input.multimodal_metadata`. Excludes cumulative `gen_ai.input.messages`; omitted when those surfaces have no media. |
| `gen_ai.output.messages` | json array | When available | Model output messages, including text, reasoning, tool-call parts, and finish reason. May contain sensitive content. |
| `gen_ai.output.multimodal_metadata` | json array | Opt-In | Summary of `uri` media on output and tool calls. Same item shape as the input summary; omitted when those surfaces have no media. |
| `gen_ai.system_instructions` | json array | When available | System prompt sent to the model on `llm.request`, as `text` parts. May contain sensitive content. |
| `gen_ai.tool.name` | string | Required for `tool.call` and `tool.result` | Tool name. |
| `gen_ai.tool.call.id` | string | Recommended when available | Tool call ID used to correlate `tool.call` and `tool.result`. |
| `gen_ai.tool.call.exec.id` | string | Recommended | Tool execution-side ID. |
| `gen_ai.tool.call.arguments` | json | When available | Tool call arguments. May contain sensitive content. |
| `gen_ai.tool.call.result` | json | When available | Tool result payload. May contain sensitive content. |
| `gen_ai.tool.call.duration` | int | Recommended | Positive tool execution duration in milliseconds, computed from the matched result boundary minus the call boundary. Omit it when either boundary is unavailable or the difference is not positive. |
| `gen_ai.skill.name` | string | Conditionally Required for `skill.use` | Skill or extension capability name. |
| `gen_ai.skill.id` | string | Recommended when skill identity is available | Stable skill identifier. |
| `gen_ai.skill.description` | string | Recommended when skill metadata is available | Human-readable skill description. |
| `gen_ai.skill.version` | string | Recommended when skill metadata is available | Skill version. |
| `error.type` | string | Conditionally Required when the operation ends with an error | Low-cardinality error type, error code, exception class, or HTTP status. |
| `error.message` | string | Recommended when `error.type` exists | Human-readable error detail. |
| `http.response.status_code` | int | Recommended when a model HTTP call fails | HTTP status of a failed model request on `llm.response`; present on both retried and terminal failures. |
| `agent.channel` | string | Recommended | Request source channel, such as `ide_plugin`, `web`, or `api`. |
| `git.domain` | string | Recommended | Git hosting domain for the active workspace. |
| `git.repo` | string | Recommended | Git repository name or URL for the active workspace. |
| `git.branch` | string | Recommended | Active Git branch. |
| `workspace.current_root` | string | Recommended | Git top-level directory, inferred when the working directory is a git repository. |
| `workspace.path` | string | Recommended | Absolute working directory the agent ran in (process cwd), independent of git. Present even when the directory is not a git repository. |
| `agent.*` | json | Opt-In | Agent-specific extension attributes. Stable high-query dimensions should become structured fields over time. |

Automatic working-directory collection covers Claude Code, Codex, Cursor / Cursor CLI, Kiro CLI, MiMo Code, OpenClaw, OpenCode, Pi Coding Agent, the Qoder family, Qoder Work / Qoder Work CN, Qwen Code CLI, Qwen Work CN, and WorkBuddy. `workspace.*` and any inferred `git.*` fields are collected independently from message extraction.

## OpenClaw Session Key

OpenClaw session keys are supported by both the legacy (2026.3.8+) and modern
adapters. Run events (`other`, `agent.input`, `llm.request`, `llm.response`,
`tool.call`, `tool.result`) retain the key when available; lifecycle-only
`session_start`/`session_end` records remain excluded from canonical output.
Missing, malformed, oversized (over 1024 characters), or conflicting keys are
not guessed or replaced with session IDs. A reset may retain the routing key
while changing the conversation UUID. Keys can contain channel/user identifiers,
so they pass through configured masking rules before event/trace export; disabling
message content alone does not remove this metadata. All other agent-scoped
extensions retain their existing JSONL/SLS filtering behavior. This field does
not automatically create an SLS index or a dedicated ARMS UI column.

## System Instructions

`gen_ai.system_instructions` carries the system prompt as an array of `text` parts on the `llm.request` event. It enters the same masking pipeline as other message content before output.

For `hermes` the prompt is read from the provider request body observed at `pre_api_request`, because `conversation_history` never replays system messages. Provider shapes are normalized to the same parts array: OpenAI-compatible `messages[]` entries with role `system` / `developer`, Responses API top-level `instructions`, Anthropic and Bedrock top-level `system` (string or block list), and Gemini `systemInstruction.parts[].text`. A blank or absent prompt yields no field.

For `hermes`, system instructions remain only in `gen_ai.system_instructions`; they are not synthesized into `gen_ai.input.messages` or `gen_ai.input.messages_delta`. This keeps the established business-turn input and `gen_ai.input.messages_hash` semantics unchanged for LLM, AGENT, and ENTRY spans.

## Multimodal Message Parts

> **Experimental.** Multimodal `uri` parts and `gen_ai.*.multimodal_metadata` may change.

When global multimodal infrastructure and the agent `uploadMode` are enabled (see [Configuration Guide](configuration.md#multimodal-object-storage) and [Multimodal Collection](multimodal.md)), media in message `parts` uses object-storage references instead of inline base64:

| `parts[].type` | Description |
|----------------|-------------|
| `text` | Text content. |
| `uri` | Uploaded or optimistic media reference; includes `uri`, `mime_type`, and optional `modality` (for example `image`). |

`uri` values look like `oss://bucket/prefix/YYYYMMDD/<sha256>.ext` or `sls://project/logstore/YYYYMMDD/<sha256>.ext`. The content hash is encoded in the object path. `YYYYMMDD` is the event's **local** calendar day (from `time_unix_ms` when present), not UTC—the same convention as the Python probe, so date-prefix queries align across implementations near midnight. A uri may dangle if upload fails; Pilot fails open and continues text collection.

## Custom Agent Identity

When a supported agent process starts with the following environment variables, Pilot writes the worker context to the current turn:

| Environment variable | Event field | Description |
|----------------------|-------------|-------------|
| `AGENTTEAMS_WORKER_NAME` | `gen_ai.agent.name`, `resourceAttributes["agentteams.worker.name"]` | Logical worker name; takes precedence over the native name for a main agent. |
| `AGENTTEAMS_INSTANCE_ID` | `resourceAttributes["agentteams.instance.id"]` | Concrete worker instance; never overwrites `gen_ai.agent.id`. |

Claude Code, Qoder, Codex, OpenCode, Pi Coding Agent, DeepSeek Harness, MiMo Code, Qwen Code CLI, and Cursor CLI support both variables. OpenClaw and Hermes Agent support only `AGENTTEAMS_WORKER_NAME` and do not currently consume `AGENTTEAMS_INSTANCE_ID`. Cursor Desktop does not consume these variables. Existing event fields and name fallbacks remain unchanged when the variables are absent. Pilot collects only the two fixed allowlisted variables above; other `AGENTTEAMS_*` variables are never written to events or OTLP resources.

## Provider Names

| Value | Description |
|-------|-------------|
| `anthropic` | Anthropic Claude models |
| `openai` | OpenAI models |
| `aws.bedrock` | AWS Bedrock hosted models |
| `azure.ai.openai` | Azure OpenAI Service |
| `azure.ai.inference` | Azure AI Inference |
| `gcp.vertex_ai` | Google Cloud Vertex AI |
| `gcp.gemini` | Google Gemini AI Studio endpoint |
| `gcp.gen_ai` | Google GenAI endpoint when the concrete backend is unknown |
| `deepseek` | DeepSeek |
| `qwen` | Alibaba Cloud Qwen |
| `groq` | Groq |
| `mistral_ai` | Mistral AI |
| `cohere` | Cohere |
| `perplexity` | Perplexity |
| `x_ai` | xAI Grok |
| `ibm.watsonx.ai` | IBM Watsonx AI |

If none of the above values apply, use a lowercase dotted provider name such as `baidu.ernie` or `zhipu.chatglm`.

## Finish Reasons

| Value | Description |
|-------|-------------|
| `stop` | Model generation completed normally. |
| `length` | Maximum output token limit was reached. |
| `tool_calls` | The model triggered a tool call. |
| `content_filter` | Content safety filtering stopped generation. |
| `end_turn` | The model ended the turn. |
| `cancelled` | The user interrupted generation; this is not a provider or agent error. |
| `error` | A single physical model request failed. For Claude Code an intermediate `error` does not end the turn; a terminal failure additionally carries `gen_ai.turn.end=true`. |
