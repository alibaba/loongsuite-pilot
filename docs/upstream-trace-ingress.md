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

References: [W3C](https://www.w3.org/TR/trace-context/), [Java](https://opentelemetry.io/docs/languages/java/api/#context-propagation), [Python](https://opentelemetry.io/docs/languages/python/propagation/), [Claude SDK telemetry](https://code.claude.com/docs/en/agent-sdk/observability), [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks). Current Claude docs describe subprocess env injection; installed release support and Pilot reconstruction require separate validation.
