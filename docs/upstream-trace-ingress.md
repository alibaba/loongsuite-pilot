# Link an upstream application span to a Pilot trace

Enable `upstreamLink.enabled`, install the Pilot Hooks, and send application and Pilot spans to the same trace backend. In the application, inject the current OpenTelemetry Context with the W3C propagator. The carrier contains `traceparent` and optional `tracestate`. Pilot resolves that carrier before it creates the ENTRY span, so the upstream span appears as the parent in the trace tree.

| Runtime | Caller | Agent-side correlation |
| --- | --- | --- |
| Codex CLI | Launch each `codex exec` or `codex exec resume` with its own `TRACEPARENT`, optional `TRACESTATE`, and a fresh `LOONGSUITE_PILOT_INGRESS_REQUEST_ID` | The UserPromptSubmit Hook binds the process invocation to the native session and turn |
| Codex TypeScript SDK | Pass that per-call environment to a fresh SDK client and run a thread | The SDK starts the CLI, which uses the same Pilot Hook |
| Qoder Agent SDK | Bind the request to a user message UUID, then send the same UUID through the SDK | Pilot matches the UUID against the native user transcript row |
| Codex ACP | Add the carrier to each `session/prompt.params._meta` | The adapted server binds the returned app-server turn ID before Pilot publishes |

For Codex CLI and SDK calls, use a fresh copy of the child environment and remove stale propagation fields first. Generate a new request UUID for each subprocess invocation. Keep session persistence enabled so Pilot can read the turn. SDK 0.169.0 accepts an `env` option on `new Codex({ env })`, replacing the inherited environment. Include the process variables needed by the CLI and its existing authentication. An unscoped `TRACEPARENT` retains the legacy first-input behavior.

Qoder Agent SDK 1.0.59 uses a shared daemon. Keep its environment stable and use the exact message ID before dispatch. The following code uses the supplied `sessionId` from an existing session or a newly generated UUID for a new query.

```js
import { randomUUID } from 'node:crypto';
import { bindUpstreamTurn } from '/path/to/pilot/hooks/shared/upstream-ingress.mjs';

const uuid = randomUUID();
bindUpstreamTurn({ agentId: 'qoder-cli', sessionId, nativeTurnId: uuid, carrier });

async function* messages() {
  yield {
    type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  };
}
// Pass messages() as query({ prompt, options })'s prompt. Use options.sessionId
// for a new session or options.resume for an existing one.
```

Keep the Pilot Stop Hook available in the SDK's settings sources or register it through the SDK. The exact Qoder match was exercised on Qoder CLI 1.1.81. The Claude Agent SDK callback contract uses the native `session_id` and `prompt_id` from `UserPromptSubmit`. Check that the installed CLI supplies a matching prompt ID in the native transcript. The live SDK comparison covers Codex and Qoder.

## Run one turn in a local Agent process

Pass `TRACEPARENT`, optional `TRACESTATE`, and a fresh
`LOONGSUITE_PILOT_INGRESS_REQUEST_ID` to each newly launched process.
The Agent must load its corresponding Pilot hook or plugin.

| Agent | Turn identity used by the adapter |
| --- | --- |
| Codex | Native turn ID from UserPromptSubmit |
| Cursor CLI | Generation ID from beforeSubmitPrompt |
| Grok Build | Native prompt ID from user_prompt_submit |
| Claude Code | Native prompt ID when supplied by UserPromptSubmit |
| Pi Coding Agent | Turn ID recorded by the Pilot extension |
| DeepSeek Harness | Native turn number from turn/start |
| OpenClaw | Native run ID in local embedded execution |

For persistent hosts, bind each request using the Agent's actual session and
turn IDs. An OpenClaw Gateway caller with these IDs can use the shared
`bindUpstreamTurn` helper before dispatch.

## Configure the ACP receiver

At ACP v1 `session/prompt`, send `_meta: { traceparent, tracestate }` alongside the regular prompt. Launch the adapted ACP server on the Agent host. The [Codex ACP example patch](../examples/upstream-trace-ingress/codex-acp-2.6.0.patch) targets version 2.6.0 at commit `656765115f82253c79f87918abb77189c114a799`. Apply the patch, install the adapter dependencies, and build it.

Set `LOONGSUITE_PILOT_INGRESS_MODULE` to the absolute path of the deployed `hooks/shared/upstream-ingress.mjs` and `LOONGSUITE_PILOT_DATA_DIR` to the collector's data directory. Point `CODEX_PATH` to the CLI that should serve ACP requests. The adapter keeps each carrier in the request callback and uses `prepareUpstreamTurn` to announce an expected binding. The callback then binds the actual native turn after the app-server acknowledges `turn/start`. The collector retries a pending exact match within its existing retry budget. The hint contains no parent context, and only the exact native binding supplies a parent. See the [Chinese runbook](zh-CN/upstream-trace-ingress.md) for full commands.

## Add an Agent adapter

Call `bindUpstreamTurn({ agentId, sessionId, nativeTurnId, carrier, dataDir })` before collection publishes the turn. Pass the corresponding native turn ID on the producer's `other` event or resolve it in the producer before pinning the trace, as Qoder does. The key uses the native identity, preserving any separate application-facing session and turn attributes. Bind on the Agent host when the caller uses a remote transport. Java and Python can pass the same object as stdin JSON to `hooks/shared/upstream-ingress-cli.mjs`, set a timeout, and inspect `recorded` in the response.

Bindings are private, atomic, and immutable. A duplicate binding with the same parent succeeds and a conflicting parent returns `conflict`. Missing context falls back to existing collection behavior. The collector supplies a remote OTel parent to ENTRY creation in both conversion paths, retaining sampling and trace state subject to the configured sampler. Retention uses `upstreamLink.ttlMs`. The feature applies to Pilot's reconstructed inbound trace.

Verify with two requests to the same native session and different application spans. Each Pilot ENTRY should be a child of its corresponding Web span in the full backend tree. See [W3C Trace Context](https://www.w3.org/TR/trace-context/) and [ACP metadata](https://agentclientprotocol.com/protocol/v1/extensibility).
