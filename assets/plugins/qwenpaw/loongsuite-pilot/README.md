# QwenPaw Pilot plugin

This native plugin uses QwenPaw Runtime hooks and AgentScope middleware without
importing the LoongSuite Python probe or initializing an OpenTelemetry exporter.
QwenPaw **2.1.0** and AgentScope **2.0.4.post1** are tested versions, not runtime
allowlists. Available APIs determine which capabilities attach. Missing optional
helper/Dream APIs disable only those integrations; missing middleware retains
Runtime ENTRY telemetry, and missing Runtime hooks retains agent-root telemetry.
Warnings report unavailable capabilities without request data. Registration
failures deactivate attached callbacks and restore owned wrappers. The manifest
uses QwenPaw's default compatibility policy without a plugin-specific version range.
The inspected QwenPaw 2.1.0 and 2.2.1b1 loaders enforce only the default minimum.
If a future loader restores its inferred upper bound for omitted ranges, that
loader policy will need reassessment; this manifest does not promise bypassing
future host compatibility rules.

Pilot deploys this directory to `$QWENPAW_WORKING_DIR/plugins/loongsuite-pilot`
(default `~/.qwenpaw/plugins/loongsuite-pilot`). QwenPaw must load it through its
normal plugin loader at startup; copying files into a running process does not
install its hooks. Restart QwenPaw after initial deployment or changes.

The writer uses `LOONGSUITE_PILOT_DATA_DIR`, then `dataDir` from the Pilot-managed
`.loongsuite-pilot-managed.json` marker, then `~/.loongsuite-pilot`. Output is
`logs/qwenpaw/qwenpaw-YYYY-MM-DD-PID.jsonl` (UTC date), with directory mode 0700
and file mode 0600. A failed write does not stop the application. It honors
`LOONGSUITE_PILOT_ENABLED=false`, configuration `enabled=false`, and
`agents.qwenpaw.enabled=false`. Setting `agents.qwenpaw.captureMessageContent`
to false removes message/system/tool content and error text before writing.

`PRE_DISPATCH` starts the request boundary. A late `POST_RESPONSE` hook ends it
at response completion, before Runtime yields its terminal envelope, so a consumer
stopping at that envelope does not strand the trace. `FINALLY` provides idempotent
fallback for errors, cancellation, and shortcuts that bypass `POST_RESPONSE`.
ENTRY measures response generation, not the entire lifetime of the consumer's
stream. Failures in later custom hooks or envelope/finalizer handling are diagnosed;
an already completed ENTRY is not rewritten and no second ENTRY is emitted. The agent middleware wraps reply,
reasoning, model and tool execution. A reversible `Agent.__init__` attachment
covers helper agents created outside QwenPaw's main builder without double
attachment. The optional reversible ReMe `dream` wrapper assigns background
work its own request identity and the owning QwenPaw agent name. Shutdown or
uninstall restores only wrappers still owned by this plugin. Existing agent
middlewares also stop collecting through the plugin owner's active flag,
including suspended streams; application execution continues unchanged.

Records use `llm.request`, `llm.response`, `tool.call`, and `tool.result`.
Boundaries use `event.name=other` with `agent.qwenpaw.boundary` equal to
`entry.start/end`, `agent.start/end`, or `step.start/end`. Each operation has a
16-character `agent.qwenpaw.span.id` and its explicit `agent.qwenpaw.parent.id`;
start/end pairs share the same ID. `gen_ai.step.id` identifies one model call,
while `agent.qwenpaw.reasoning.id` and `.round` identify the containing ReAct
step. A STEP remains open through tool execution and closes when the next
reasoning starts or the agent finishes; Runtime cancellation closes children
before the terminal request boundary. `gen_ai.turn.end=true` appears only on the request end record. Timestamps
are decimal nanosecond strings; TTFT is a numeric nanosecond duration measured
at the first observed nonempty streaming content. Non-streaming responses do
not receive synthetic TTFT. Tool duration follows Pilot's millisecond contract.

Session IDs remain stable across turns; request IDs identify turns and request
user IDs identify users. No product-specific Task or run metadata is read. Stream context is restored before yielding to callers.
The native `Skill` tool records name, workspace-scoped ID, description and
version from already loaded Skill metadata and QwenPaw's bounded frontmatter
reader (with the Python probe's legacy manifest version fallback). Arbitrary
`read_file` calls are not inferred to be skill invocations. Nested tool-result
blocks are normalized into GenAI parts while scalar/map results remain intact.

Final agent output comes from actual reply messages, excluding earlier tool
interactions. No model call is invented for a shortcut. Runtime shortcuts that
never invoke an agent have no middleware-derived reply content.

Focused tests (with the pinned QwenPaw environment):

```sh
python -m unittest discover -s tests/unit/hooks/qwenpaw-plugin -v
```

Dream supports both the legacy async `dream(...)` method and QwenPaw 2.2's async `run_action("auto_dream", ...)` API. The plugin selects the legacy method when available, otherwise the action API, and patches only one boundary. Other memory actions are untouched. The owning Agent name propagates through a fresh background scope; errors, cancellation, returned failures and unavailable actions retain the original business result. Cleanup restores only the method wrapper owned by this plugin.
