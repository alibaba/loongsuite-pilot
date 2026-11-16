# Shared W3C trace-context propagation

Pilot reconstructs spans from Agent events after execution. Propagating an ID chosen only during export is too late: a gateway or child process has already executed. The shared runtime therefore binds each native turn and reserves its ENTRY, AGENT and outgoing operation identities **before dispatch**, then the converter reuses those exact identities.

```text
Caller span → Pilot ENTRY → AGENT → STEP → LLM/TOOL → downstream spans
```

This is an opt-in extension of [upstream correlation](zh-CN/upstream-trace-correlation.md), not a new wire protocol. Extraction and injection use OpenTelemetry's `W3CTraceContextPropagator`. Trace ID, sampling flags and valid `tracestate` survive conversion; an unsampled upstream parent stays unsampled. No global SDK/context manager is installed by the runtime.

## Configuration

Merge into the existing Pilot configuration and restart the collector and Claude Code:

```json
{
  "upstreamLink": {
    "enabled": true,
    "sharedContext": true,
    "propagateToTools": true,
    "propagateToLlm": true,
    "generateTraceWhenMissing": true,
    "ttlMs": 86400000
  }
}
```

`sharedContext` defaults to `false`; its environment override is `LOONGSUITE_PILOT_UPSTREAM_LINK_SHARED_CONTEXT`. `generateTraceWhenMissing` is a separate opt-in: it creates a local root, not a fabricated remote parent. Invalid incoming context is not replaced with a generated trace. Environment overrides must reach both the collector and the Agent. Updating files does not update an already-running Agent preload.

## Caller integration

After building/installing Pilot, the standalone CommonJS runtime is available as `loongsuite-pilot/trace-context.cjs`. A caller that knows the **native** Agent/session/turn identity binds the turn before sending its request:

```js
const {
  TraceContextRuntime, activeContext, injectCarrier, inputHash,
} = require('loongsuite-pilot/trace-context.cjs');

const runtime = new TraceContextRuntime(pilotDataDir);
const binding = runtime.bindTurn({
  agentType: 'claude-code',
  sessionId: nativeSessionId,
  turnId: nativeTurnId,
  inputHash: inputHash(prompt),
}, injectCarrier(activeContext()));
await sendAgentRequest(prompt);
```

The caller must already have an active OTel span, or pass an explicitly extracted carrier to `bindTurn`. External business IDs are not substitutes for native IDs. Caller, hooks and collector must use the same data directory. If the native turn ID is unavailable, an input hash can match a single unclaimed turn; ambiguous matches fail open. Do not rely on hash-only matching for concurrent identical prompts.

For a newly launched Claude Code process, `TRACEPARENT` / `TRACESTATE` can provide the first turn's parent. Claude's `UserPromptSubmit` hook binds it before tool/LLM execution. Process environment is never used as a per-request parent for subsequent turns. Existing `acp-correlate` files still support post-execution linking, but alone do **not** guarantee pre-dispatch downstream propagation: bind the shared turn first when outgoing correlation is required.

## Thin framework adapter

Adapters provide native identity, execute the dispatch hook, and retain operation identity on emitted records; protocol logic stays in the shared core:

```js
const {
  bindingContext, bindingFields, injectHttpHeaders,
  injectMetadata, injectEnvironment, withTraceContext,
} = require('loongsuite-pilot/trace-context.cjs');

const operation = binding && runtime.reserveOperation(
  binding, 'tool', nativeToolCallId, physicalAttemptId,
);
if (operation) {
  const value = bindingContext(binding, operation.spanId);
  const headers = injectHttpHeaders(value, originalHeaders);
  const params = injectMetadata(value, originalMcpParams);
  const env = injectEnvironment(value, originalChildEnvironment);
  await withTraceContext(value, () => dispatch({ headers, params, env }));
}
```

Use only the carrier appropriate to that transport:

- HTTP: `traceparent` / `tracestate` headers; preserve body, cancellation and errors.
- MCP/ACP-shaped JSON-RPC: `params._meta.traceparent` / `tracestate`; preserve business arguments and other metadata. The receiver must explicitly extract these fields.
- Child process: per-spawn `TRACEPARENT` / `TRACESTATE`, without mutating `process.env`.

Emit `bindingFields(binding)` on **every** record of the turn and the reserved `span_id` on both request/response records of that operation. Keep native session/turn correlation fields intact until the collector linker runs, before identity overrides and content masking. Complete the binding with `runtime.completeTurn(binding)` only when the native turn finishes. Replaying a completed turn may reload an existing reservation but cannot create new outgoing operations.

HTTP/metadata injection preserves an existing caller-owned `traceparent`; that path must not claim a new Pilot operation ID. Child environments intentionally replace inherited context with the current operation. Baggage is not propagated automatically because it can contain sensitive application data.

## Claude Code adapter

- `UserPromptSubmit` binds the native prompt ID when supplied, otherwise the prompt hash.
- `PreToolUse(Bash)` reserves the TOOL ID and updates only the command's child environment.
- Fetch preload resolves the turn at each physical `/v1/messages` send (global fetch and Bun FetchSession), reserves a distinct LLM ID per physical attempt and injects headers before dispatch.
- `Stop`/`StopFailure` reuse the same binding and reservations. Response/attempt enrichment with a different binding ID is not merged.
- Multiple active turns without an exact request turn ID cause outgoing injection to be skipped rather than selecting the latest turn.

This PR does not install MCP, OpenClaw, Hermes, PowerShell or subagent outgoing adapters. Their integrations can use the shared API, but carrier helpers are not proof that an installed framework invokes them. Transcript-only integrations cannot inject into traffic they do not control.

## Persistence and failure behavior

Private state lives under `<dataDir>/trace-context/turns/`, separated by hashed Agent/session identity. Files contain IDs and prompt hashes, not prompt text. New files use atomic hard-link publication and owner-only permissions where supported. Conflicting, corrupt, expired or unreadable state returns no binding; telemetry failures do not repeat or block business requests.

Reads are limited to 16 KiB per record, 1024 entries per session scan and 128 active/non-expired bindings per session. New session directories are capped at 1024. Runtime records expire after the configured TTL (24 hours by default, maximum seven days); malformed/orphan records are reclaimed after seven days. Collector idle maintenance visits 32 session directories per cycle with a rotating cursor. Capacity exhaustion skips propagation instead of unbounded allocation. These are safety limits, not a lossless delivery guarantee.

Canonical-turn decisions and binding claims survive restarts. A turn already published without a shared binding cannot be reparented by a late binding. Concurrent identical prompts without a native discriminator, crash recovery beyond retention, and remote hosts without shared storage require an explicit adapter/lifecycle contract.

## References and validation

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OTel propagation API](https://opentelemetry.io/docs/specs/otel/context/api-propagators/)
- [OTel environment carrier](https://opentelemetry.io/docs/specs/otel/context/env-carriers/)
- [MCP metadata](https://modelcontextprotocol.io/specification/2025-11-25/basic)

Tests cover persistence/replay, competing parents, asynchronous scope, sampling/state, sequential repeated prompts, per-attempt IDs, real loopback HTTP retries, real Bash child context and the Claude Hook → event → OTLP converter chain. MCP tests cover serialized metadata and receiver extraction, not a production SDK transport. Native authenticated Agent and cloud backend acceptance must be reported separately from these tests.
