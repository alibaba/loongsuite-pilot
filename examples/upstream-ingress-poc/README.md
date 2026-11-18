# Upstream trace ingress prototypes

This directory contains executable prototypes for one shared request-scoped W3C bridge:

| Prototype | Actual components | Fixture boundary |
| --- | --- | --- |
| HTTP → CLI | HTTP server, OTel propagator, child process, Pilot linker and OTLP flusher | Agent CLI, Hook notification and transcript are fixtures |
| Python OTel → CLI | Official Python OpenTelemetry API and propagator, child process, Pilot linker and OTLP flusher | Python uses a synthetic active SpanContext; Agent CLI and transcript are fixtures |
| Codex SDK | Published Codex TypeScript SDK, Pilot Codex transcript builder, linker and OTLP flusher | The SDK launches a fixture CLI; the generic native-turn field is added by the prototype adapter |
| Claude Agent SDK | Published Claude TypeScript SDK, its UserPromptSubmit callback, Pilot Claude Hook processor, linker and OTLP flusher | The SDK launches a fixture CLI and the transcript is synthetic; real CLI/Hook identity preservation is not established |
| Qoder SDK | Published Qoder TypeScript SDK, shared daemon transport, Pilot Qoder transcript collector, linker and OTLP flusher | A fixture daemon preserves the user-message UUID; the generic native-turn field is added by the prototype adapter |
| ACP | Published ACP TypeScript SDK on both sides of a stdio connection, Pilot linker and OTLP flusher | The ACP server is a fixture Agent that binds its generated native turn ID |

The prototypes do **not** install a Pilot integration into any native Agent or ACP adapter. The caller-visible helper in `ingress.mjs` is experimental and is not a released public API. In particular, a Qoder message UUID is only useful if the installed Qoder runtime is independently verified to preserve it in the transcript, and an ACP adapter must establish the mapping to the Agent's real native session and turn.

## Run

From the repository root, install the existing Pilot development dependencies. Then install the prototype's separately pinned SDKs and run it:

```sh
npm install
cd examples/upstream-ingress-poc
npm install --ignore-scripts --omit=optional
npm run poc
```

No account, network model call, or shared Agent settings are needed for the prototype. `--ignore-scripts --omit=optional` skips native CLI downloads that the fixtures do not use. The HTTP server binds to loopback. The final JSON reports each case, its caller/ENTRY IDs, `tracestate`, event count and span count. Set `POC_EVIDENCE_FILE` to save that JSON to a file.

The Python case additionally needs `opentelemetry-api` in the selected Python environment. Set `POC_PYTHON` to select its interpreter. If the dependency is absent, the runner reports this case as `SKIP`; it does not count it as passed. `POC_PYTHONPATH` can supply an existing package path for an isolated test.

The run checks:

- HTTP context extraction and propagation into separate child-process environments; two requests reuse the same session and two other requests run concurrently.
- Two Codex SDK calls that resume the same session, each with a separately captured environment.
- Two Claude Agent SDK calls that resume the same session. Their UserPromptSubmit callbacks bind separate request contexts using the supplied prompt ID, and the actual Claude Hook processor generates the matching Pilot events. A missing prompt ID remains unbound.
- Two Qoder SDK requests using the same daemon and session, with distinct message UUIDs and identical prompt text.
- Two ACP prompt messages on the same session, with W3C fields in `_meta` and a receiver-side binding before publication.
- Missing identity, invalid carrier, conflicting bindings, stale environment cleanup, binding before publication, and an unsampled parent.

The `late-binding-before-publication` case shows that an already observed input can be retained until its binding arrives. It is a controlled sequence, not a complete bounded production queue, crash recovery or latency test.

## Shared bridge

`captureIngress(context)` captures one request's OTel Context. Its `childEnv()` creates a private environment copy; `acpMeta()` creates ACP metadata; `bindNative()` associates the carrier with an Agent's native session and turn. Agent-side adapters can call `bindIngress()` after receiving the carrier. The shared binder and Pilot conversion are the implementation from PR #615; the framework-specific identity fields in this directory are prototypes.

The carrier is `traceparent` plus optional `tracestate`. It includes both the trace ID and the real parent span ID. No prompt text is used as the exact correlation key. If native identity is missing or invalid, fail open to an independent trace rather than attaching the request to a guessed turn.

For a real SDK or ACP server, the adapter must bind before Pilot publishes the input turn. If the native turn ID is learned later, the Pilot collector needs a bounded per-turn staging barrier; it must not hold up the business request or change the parent after a span has already been emitted.

See [the Chinese design](../../docs/zh-CN/unified-upstream-trace-poc.md) for the customer changes, production work and evidence limits.
