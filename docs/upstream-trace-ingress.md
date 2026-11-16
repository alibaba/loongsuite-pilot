# Upstream application → Agent / Pilot: W3C ingress

Enable `upstreamLink.enabled` and configure OTLP output. This links the caller span to Pilot's reconstructed ENTRY/AGENT tree; it does not instrument the Agent's active context or inject outgoing HTTP/MCP headers. `propagateToTools` is not required.

## Fresh subprocess: environment bridge

Inject the caller's current OTel Context, then map carrier `traceparent`/`tracestate` to `TRACEPARENT`/`TRACESTATE` in a per-call child environment. Claude's Pilot `UserPromptSubmit` captures it before execution, with Stop as a compatibility fallback. No Bash call is required. Existing Codex/Qoder/Qwen Code shared-helper paths remain available; other Agents need lifecycle adapters.

Static env is a **first-collected-input-turn fallback**, not per-request propagation for a persistent shared session. Do not apply a new request's environment to resumed sessions with historical backlog.

## SDK / Plugin: exact native-turn binding

Capture the carrier before dispatch; bind synchronously when a request-scoped callback supplies native IDs:

```js
import { propagation } from '@opentelemetry/api';
import { bindUpstreamTurn } from './assets/hooks/shared/upstream-ingress.mjs';

const carrier = {};
propagation.inject(carrier);
const bindRequest = input => {
  const result = bindUpstreamTurn({
    agentId: 'claude-code', sessionId: input.session_id,
    nativeTurnId: input.prompt_id, carrier,
  });
  if (!result.recorded) console.warn('Pilot ingress skipped:', result.reason);
  return {};
};
```

Claude SDK `UserPromptSubmit` callbacks run in the caller process, so a closure can carry request context. Adapt signatures to the installed SDK. Shell hook payloads do not automatically contain trace headers. Missing native IDs return `invalid`; do not fabricate IDs from text or business sessions. Scope each callback to one request: autonomous later turns or concurrent requests must not inherit a stale closure.

Java/Python can call `node assets/hooks/shared/upstream-ingress-cli.mjs`, send the same object once via stdin, and inspect `{ "recorded": true }`. The dependency-free CLI accepts at most 8 KiB and waits at most two seconds for stdin. It exits zero on telemetry failure, so check `recorded`, impose a caller timeout and keep the business invocation fail-open. See the [Chinese guide](zh-CN/upstream-trace-ingress.md) for Python examples.

Bindings use hashed `(agentId, native sessionId, nativeTurnId)` namespaces and private, atomically published immutable files. Retries are idempotent; conflicting parents return `conflict`. Identical prompts remain independent, and checkpoint replay restores the binding until existing `upstreamLink.ttlMs` retention removes it. Caller and collector must share the same readable data directory. `dataDir` defaults to `LOONGSUITE_PILOT_DATA_DIR` or `~/.loongsuite-pilot`.

## Thin Agent contract

Bind before the first input boundary; emit `agent.pilot.correlation.native_turn_id` on its `other` input event (preferably all records). Preserve canonical `gen_ai.turn.id`. Claude stamps transcript `promptId`, using the existing single-turn Stop fallback when applicable. Other Agent SDK adapters are not installed by this PR merely because the core supports them.

Precedence: native delegated/locked contexts stay authoritative; otherwise native binding → legacy ACP hash/prefix → first-turn env → local context. Legacy repeated-prompt concurrency retains ordering ambiguity. Publish before collection: no previously exported span is rewritten.

Official OTel extraction provides a remote parent to ENTRY creation in batch and streaming paths, retaining flags and `tracestate`. The default parent-based sampler does not export sampled spans for unsampled parents; explicit `OTEL_TRACES_SAMPLER` overrides follow SDK policy. Invalid tracestate follows the official parser. Content-off stays independent of linking.

Trace-ID-only merging loses topology and sampling semantics; accept a valid W3C carrier rather than fabricate a parent. Outgoing propagation, baggage, MCP adapters and span-ID reservations are separate work.

## CLI, SDK and ACP support boundaries

Audited on 2026-11-16; see the [detailed Chinese scenario guide](zh-CN/upstream-trace-ingress.md#三种上游调用场景的实际支持范围). Synthetic converter fixtures with a manually supplied native alias do not prove native framework adapter support.

| Upstream path | Current support | Caller/receiver changes |
| --- | --- | --- |
| HTTP service → fresh CLI process and native session | Environment bridge for Claude/Codex, first collected input only | Inject the current server/call span into a per-call child env; keep Pilot Hooks/transcript collection active |
| Official Agent SDK | Conditional on process and session lifetime | Fresh sessions may use SDK env; reused sessions need request-scoped binding or legacy per-turn correlation |
| ACP microservice call | Shared store/converter, not an automatic ACP receiver | Inject `params._meta` on each prompt; extract and bind on the Agent host before publication |

Claude SDK currently auto-injects active context at subprocess startup, not at every query on a persistent client. Explicit TypeScript env replaces inherited env; Python merges it. Check installed versions and Pilot Hook activation. The exact callback path needs a real `prompt_id` matching the transcript, not a business request ID. A persistent client's callbacks need an explicit request mapping rather than a stale closure.

Codex SDK 0.169.0 has constructor-scoped env and spawns `codex exec` per run, using `exec resume` for reused threads. Changing the application's active Context does not change that client env. A fresh process with a resumed session is still not a new Pilot first turn. The Codex producer does **not** emit the generic native-turn alias in this PR, so calling the exact bind API alone does not link actual Codex events. Use the existing native-session/input-hash protocol or add the producer alias and a pre-publication caller bridge.

Qoder SDK 1.0.59 now defaults to a process-wide daemon. Env configures the daemon; incompatible per-query env is rejected with `DaemonConfigurationConflictError`. Do not use a single business request's parent as the shared daemon's startup env. Request-scoped legacy correlation needs native session identity and matching input, with serialization for identical inputs until an exact adapter exists. Qoder's producer has no generic native alias and its public UserPromptSubmit type does not promise a prompt/turn ID. Locked/published Qoder checkpoint recovery stores only trace/parent IDs, not the full W3C carrier; full flags/state preservation across that path remains an adapter gap.

[ACP extensibility](https://agentclientprotocol.com/protocol/extensibility) recommends reserving root `_meta.traceparent`, `tracestate` and `baggage` for W3C context. Transporting those fields is not the same as consuming them. The audited Claude/Codex ACP adapters do not bridge W3C prompt metadata to Pilot. Their long-lived SDK/app-server processes need an Agent-side request bridge: exact native binding where supported, or the legacy per-turn file before dispatch. JSON-RPC request IDs are not native turn IDs. Confirm session mapping and prompt transformation; write on the receiving host or shared volume, not an inaccessible caller filesystem. HTTP gateways extract/re-inject headers; stdio uses JSON-RPC metadata, not HTTP headers. This PR does not implement baggage.

Published Codex/Qoder SDKs were exercised with a fake CLI to verify env/resume/daemon behavior without model calls. Actual Codex builder/linker and Qoder collector components were checked with synthetic source records; a simulated locked checkpoint demonstrates the Qoder carrier gap. These are not native CLI/SDK/ACP end-to-end acceptance for all three scenarios.

References: [W3C](https://www.w3.org/TR/trace-context/), [Java](https://opentelemetry.io/docs/languages/java/api/#context-propagation), [Python](https://opentelemetry.io/docs/languages/python/propagation/), [Claude SDK telemetry](https://code.claude.com/docs/en/agent-sdk/observability), [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks). Current Claude docs describe subprocess env injection; installed release support and Pilot reconstruction require separate validation.
