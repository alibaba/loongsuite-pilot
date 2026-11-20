# Link an upstream application span to a Pilot trace

In the application, inject the current OpenTelemetry Context with the W3C propagator. The carrier contains `traceparent` and optional `tracestate`. Pilot resolves that carrier before it creates the ENTRY span, so the upstream span appears as the parent in the trace tree.

## Set up Pilot

[Install a Pilot build with per-turn upstream linking](installation.md) on the Agent host. Deploy the matching Hook or plugin and keep the Agent's session records available to Pilot. Add this setting to the existing `~/.loongsuite-pilot/config.json`. Configure [OTLP trace output](trace-output.md) so the application's spans and Pilot spans go to the same trace backend.

```json
{
  "upstreamLink": { "enabled": true }
}
```

Restart Pilot and check the Hook installation.

```sh
loongsuite-pilot restart
loongsuite-pilot hook status --json
```

If Codex needs its user Hook installed, run `loongsuite-pilot hook install --agents codex --scope user`. See [Agent Configuration](agents.md) for other Agents and deployment modes.

If you use a custom Pilot data directory, set `LOONGSUITE_PILOT_DATA_DIR` on the Agent process or pass `dataDir` to the binding helper. Use the same directory for the collector.

## Choose a calling method

| Runtime | Caller | Agent-side correlation |
| --- | --- | --- |
| Codex CLI | Launch each `codex exec` or `codex exec resume` with its own `TRACEPARENT`, optional `TRACESTATE`, and a fresh `LOONGSUITE_PILOT_INGRESS_REQUEST_ID` | The UserPromptSubmit Hook binds the process invocation to the native session and turn |
| Codex TypeScript SDK | Pass that per-call environment to a fresh SDK client and run a thread | The SDK starts the CLI, which uses the same Pilot Hook |
| Qoder Agent SDK | Bind the request to a user message UUID, then send the same UUID through the SDK | Pilot matches the UUID against the native user transcript row |
| Codex ACP | Add the carrier to each `session/prompt.params._meta` | The adapted server binds the returned app-server turn ID before Pilot publishes |

## Use an Agent SDK

For Codex TypeScript SDK 0.169.0, create a client for each call using `new Codex({ env })`. Follow the [per-call environment example](#run-one-turn-in-a-local-agent-process) and include the process variables needed by the CLI, including PATH and authentication. Use `startThread()` or `resumeThread(sessionId)`. The SDK launches a CLI process for each `thread.run()`.

Qoder Agent SDK 1.0.59 uses a shared daemon. Keep its environment stable. Pass the current request's W3C carrier and bind the exact message UUID before dispatch.

```js
import { randomUUID } from 'node:crypto';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { bindUpstreamTurn } from '/path/to/pilot/hooks/shared/upstream-ingress.mjs';

export function runQoder(prompt, carrier, sessionId = randomUUID(), resume = false) {
  const uuid = randomUUID();
  bindUpstreamTurn({ agentId: 'qoder-cli', sessionId, nativeTurnId: uuid, carrier });
  async function* messages() {
    yield {
      type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    };
  }
  return query({ prompt: messages(), options: {
    auth: qodercliAuth(),
    ...(resume ? { resume: sessionId } : { sessionId }),
  } });
}
```

For a follow-up, pass the existing session ID and set `resume` to `true`. Keep the Pilot Stop Hook available in the SDK's settings sources or register it through the SDK. The example uses Qoder CLI login and was exercised on Qoder CLI 1.1.81. Use the application's configured SDK authentication in production.

The Claude Agent SDK callback contract uses the native `session_id` and `prompt_id` from `UserPromptSubmit`. Check that the installed CLI supplies a matching prompt ID in the native transcript. The live SDK comparison covers Codex and Qoder.

## Run one turn in a local Agent process

Pass `TRACEPARENT`, optional `TRACESTATE`, and a fresh
`LOONGSUITE_PILOT_INGRESS_REQUEST_ID` to each newly launched process.
Use the following Python example from the request handler while its Web span is current. The example uses `opentelemetry-api`.

```python
import os
import subprocess
from uuid import uuid4
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

def agent_env():
    carrier = {}
    TraceContextTextMapPropagator().inject(carrier)
    propagation_keys = {"traceparent", "tracestate", "loongsuite_pilot_ingress_request_id"}
    env = {
        key: value for key, value in os.environ.items()
        if key.lower() not in propagation_keys
    }
    if "traceparent" in carrier:
        env.update({key.upper(): value for key, value in carrier.items()})
        env["LOONGSUITE_PILOT_INGRESS_REQUEST_ID"] = str(uuid4())
    return env


def run_codex(prompt, session_id=None):
    command = ["codex", "exec", "--json"]
    if session_id:
        command.extend(["resume", session_id])
    return subprocess.run(command + [prompt], env=agent_env(), stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, check=True, timeout=120)
```

Read `thread_id` from the `thread.started` event in Codex's stdout and pass it as `session_id` on the next request. Keep session persistence enabled so Pilot can read the transcript. The Hook binds each invocation to the native turn ID. Passing `TRACEPARENT` alone uses the session-first compatibility path.

| Agent | Turn identity used by the adapter |
| --- | --- |
| Codex | Native turn ID from UserPromptSubmit |
| Cursor CLI (interactive) | Generation ID from beforeSubmitPrompt |
| Grok Build (including `-p` and `--resume`) | Native prompt ID from user_prompt_submit |
| Claude Code | Native prompt ID when supplied by UserPromptSubmit |
| Pi Coding Agent | Turn ID recorded by the Pilot extension |
| DeepSeek Harness | Native turn number from turn/start |
| OpenClaw | Native run ID in local embedded execution |

For persistent hosts, bind each request using the Agent's actual session and
turn IDs. An OpenClaw Gateway caller with these IDs can use the shared
`bindUpstreamTurn` helper before dispatch.

### Start and resume Cursor CLI

1. Sign in with `cursor-agent login` and check `cursor-agent status` as the CLI user. Use `agent` if that is the installed command name.
2. From the Web request handler, launch `cursor-agent --model auto --mode ask` with `env=agent_env()` in an interactive terminal or PTY. Submit the prompt when the interface is ready. After the response, save the session ID with `/copy-conversation-id` and exit with `/exit`.
3. On the next Web request, call `agent_env()` again and launch `cursor-agent --model auto --mode ask --resume <session-id>`. Wait for the session to load before submitting the prompt. [Cursor CLI commands](https://cursor.com/docs/cli/reference/slash-commands)

On the tested Cursor CLI `2026.11.19-f005e9d`, `-p` (`--print`) omits `beforeSubmitPrompt`, `afterAgentResponse`, and `stop`, which Pilot needs to bind and collect the turn. Use `--list-models` to check the account's available models. The tested CLI rejected `qwen-plus`. If Cursor repeatedly reconnects, set `network.useHttp1ForAgent` to `true` in its `cli-config.json` and relaunch the CLI. [Cursor CLI configuration](https://cursor.com/docs/cli/reference/configuration)

### Start and resume Grok Build

Pass `env=agent_env()` on each Web request. Start with `grok --output-format json -p "<prompt>"` and read `sessionId` from the JSON reply. On the next request, run `grok --output-format json --resume <session-id> -p "<prompt>"`.

DashScope `qwen-plus` was tested on Grok Build 1.0.89. Add the model to `$GROK_HOME/config.toml` (default `~/.grok/config.toml`). Pass `DASHSCOPE_API_KEY` in the child environment and add `--model bailian-qwen-plus` to both commands. Use a `base_url` in the same region as the API key. [Grok Build model settings](https://docs.x.ai/build/settings) · [DashScope compatible endpoints](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)

```toml
[model.bailian-qwen-plus]
model = "qwen-plus"
name = "Bailian Qwen Plus"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
env_key = "DASHSCOPE_API_KEY"
api_backend = "chat_completions"
```

## Configure the ACP receiver

At ACP v1 `session/prompt`, send `_meta: { traceparent, tracestate }` alongside the regular prompt. Launch the adapted ACP server on the Agent host. The [example patch](../examples/upstream-trace-ingress/codex-acp-2.6.0.patch) targets Codex ACP 2.6.0. Substitute the local paths and run the adapter.

```sh
git clone https://github.com/agentclientprotocol/codex-acp.git
cd codex-acp
git checkout 656765115f82253c79f87918abb77189c114a799
git apply /path/to/loongsuite-pilot/examples/upstream-trace-ingress/codex-acp-2.6.0.patch
npm ci
npm run build
export LOONGSUITE_PILOT_DATA_DIR=/path/to/pilot-data
export LOONGSUITE_PILOT_INGRESS_MODULE="$LOONGSUITE_PILOT_DATA_DIR/hooks/shared/upstream-ingress.mjs"
export CODEX_PATH=/path/to/codex
node dist/index.js
```

Use the collector's data directory for `LOONGSUITE_PILOT_DATA_DIR`. The adapter keeps each carrier in the request callback and uses `prepareUpstreamTurn` to announce an expected binding. The callback then binds the native turn after the app-server acknowledges `turn/start`. The collector retries the pending match within its retry budget and uses the exact binding as the parent.

## Add an Agent adapter

Call `bindUpstreamTurn({ agentId, sessionId, nativeTurnId, carrier, dataDir })` before collection publishes the turn. Pass the corresponding native turn ID on the producer's `other` event or resolve it in the producer before pinning the trace, as Qoder does. The key uses the native identity, preserving any separate application-facing session and turn attributes. Bind on the Agent host when the caller uses a remote transport. Java and Python can pass the same object as stdin JSON to `hooks/shared/upstream-ingress-cli.mjs`, set a timeout, and inspect `recorded` in the response.

Bindings are private, atomic, and immutable. A duplicate binding with the same parent succeeds and a conflicting parent returns `conflict`. Missing context falls back to existing collection behavior. The collector supplies a remote OTel parent to ENTRY creation in both conversion paths, retaining sampling and trace state subject to the configured sampler. Retention uses `upstreamLink.ttlMs`. The feature applies to Pilot's reconstructed inbound trace.

## Verify the result

1. Send two Web requests to the same native Agent session. Each request must have its own Web span.
2. Find both traces in the backend. For each turn, the Pilot ENTRY must share its Web span's `traceId`, and ENTRY's `parentSpanId` must equal that Web span's `spanId`.
3. If only the Web span appears, check that the Agent ran the Pilot Hooks, the collector can read the transcript, and both exporters target the same backend. If Pilot starts a separate trace, check the carrier and the native session and turn IDs used for binding.

See [W3C Trace Context](https://www.w3.org/TR/trace-context/) and [ACP metadata](https://agentclientprotocol.com/protocol/v1/extensibility).
