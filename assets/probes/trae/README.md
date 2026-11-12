# loongsuite-pilot-trae-probe

Plugin-probe preload for **Trae IDE** (Code OSS-derived Electron IDE, 3.4.17).
Loaded via `NODE_OPTIONS="--import file://<abs>/probe.mjs"` before Trae Electron
(main process + ext-host fork) starts. Monkey-patches `node:https.request` to
capture chatverse LLM/Tool traffic and write event-log JSONL consumed by
loongsuite-pilot's `BaseHookInput` pipeline.

## Layout

```
assets/probes/trae/
├── probe.mjs              # Standalone ESM preload (NODE_OPTIONS --import)
├── package.json           # Trae 3.4.17 baseline + pilot metadata
├── scripts/
│   ├── install.sh         # PATH wrapper install (env-inject)
│   └── uninstall.sh       # PATH wrapper removal (preserves logs/)
└── README.md
```

## Install / Uninstall

Invoked by `PluginProbeStrategy.deploy()` / `undeploy()`
(`src/deployment/plugin-probe-strategy.ts:127-138` + `:185-194`).

`install.sh` writes PATH wrappers at `$PILOT_DATA/bin/{trae,trae-cn}` that
export `NODE_OPTIONS="--import file://$PILOT_DATA/plugins/trae/probe.mjs"`
+ `PILOT_LOG_DIR=$PILOT_DATA/logs/trae` before exec'ing the real Trae
binary. No `worker.manifest.json` is created (Trae itself is the worker).

`uninstall.sh` removes the wrappers and strips the PATH injection block
from `~/.bashrc` / `~/.zshrc` / `~/.profile`. Historical traces under
`$PILOT_DATA/logs/trae` are preserved.

## Event schema

Records conform to `docs/EVENT_LOG_TO_TRACE_SPEC.md` (`event-log-spec`):

| event.name    | Source                                       |
|---------------|----------------------------------------------|
| `llm.request` | POST `/api/ide/v1/chat` (chatAPI)            |
| `llm.response`| chat streamed response, or agent_finish usage|
| `tool.call`   | POST `/api/ide/v1/agents/runs/:id/tool_call_outputs` or `/api/ide/v1/web_search` request |
| `tool.result` | corresponding response                       |
| `other`       | lifecycle activate / wrap failures           |

### ID 三件套 mapping

| Trae field             | event-log field        |
|------------------------|------------------------|
| `conversation_id`      | `gen_ai.session.id` + `trace_id` |
| `chat_session_id`      | `gen_ai.turn.id`       |
| `chat_message_id`      | `gen_ai.step.id`       |
| `tool_call_key`        | `gen_ai.tool.call.id`  |

### Tool status 6→4 归并

| Trae status   | event-log status |
|---------------|------------------|
| `pending`     | `running`        |
| `running`     | `running`        |
| `success`     | `success`        |
| `failed`      | `failed`         |
| `canceled`    | `cancelled`      |
| `interrupted` | `cancelled`      |

### Usage field renaming (fx-5)

| Trae field            | event-log field            |
|-----------------------|----------------------------|
| `prompt_tokens`       | `gen_ai.usage.input_tokens`|
| `completion_tokens`   | `gen_ai.usage.output_tokens`|
| `total_tokens`        | `gen_ai.usage.total_tokens`|

## Host whitelist

Only 4 chatverse production hosts are intercepted (architect `2fdcb032` 收敛):
- `chatverse-prod.byteintl.net`
- `chatverse-us-prod.byteintl.net`
- `chatverse-us.byteintl.net`
- `chatverse.byteintl.net`

## Trae baseline

Aligned with Trae CN 3.4.17 (`product.json`):
- `appVersion`: 3.4.17
- `tronBuildVersion`: 2.3.102035
- `commit`: d654d294a690adb43b5bb35d5b37adf9f292cee0
