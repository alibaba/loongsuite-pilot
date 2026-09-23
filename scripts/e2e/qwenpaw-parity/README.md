# QwenPaw runtime parity

Two isolated Python environments exercise the actual QwenPaw Runtime and a
real DashScope model. The reproducible baseline uses QwenPaw 2.1.0 and
AgentScope 2.0.4.post1; these are test pins, not plugin compatibility gates. Baseline loads LoongSuite
Python 0.9.0 instrumentors; Pilot loads the native plugin through QwenPaw's
PluginLoader without enabling Python automatic instrumentation.

```bash
bash scripts/e2e/qwenpaw-parity/prepare.sh /tmp/qwenpaw-pilot-ab-example
```

Supply `DASHSCOPE_API_KEY` in the process environment. The harness stores it
only in the isolated QwenPaw secret directory; never commit the test data root.
The harness sets `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`
and records it in run metadata. Primary scenarios default to
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`. Configure the
Pilot collector with `agents.qwenpaw.captureMessageContent=true` as well.
`--capture-mode NO_CONTENT` is only for separately labelled privacy-negative
scenarios; it cannot prove happy-path content completeness. Historical evidence
without the semconv opt-in supports structural/usage comparisons, not content parity.

```bash
/tmp/qwenpaw-pilot-ab-example/baseline/venv/bin/python scripts/e2e/qwenpaw-parity/run_runtime.py \
  --root /tmp/qwenpaw-pilot-ab-example/baseline-run --mode baseline --matrix
/tmp/qwenpaw-pilot-ab-example/pilot/venv/bin/python scripts/e2e/qwenpaw-parity/run_runtime.py \
  --root /tmp/qwenpaw-pilot-ab-example/pilot-run --mode pilot --matrix \
  --plugin assets/plugins/qwenpaw/loongsuite-pilot
python3 scripts/e2e/qwenpaw-parity/compare.py \
  --baseline /tmp/qwenpaw-pilot-ab-example/baseline-run \
  --pilot /tmp/qwenpaw-pilot-ab-example/pilot-run
```

The matrix includes a real file tool, a second turn, nonstreaming model output,
two concurrent sessions, a missing-file tool failure, cancellation after the
first output, and a real provider 404 for an intentionally invalid model.
The observer's POST_AGENT_BUILD hook sets the actual model's stream flag for
the nonstream scenario because QwenPaw's provider factory defaults to streaming.
No model or tool response is mocked. Add `--dream` to seed a synthetic daily
memory and invoke the actual ReMe Dream workflow (120-second bound).

Evidence lives under each run's `evidence/`: raw Runtime events, correlated
request/model/tool observer events, scenario outcomes, dependency versions, and
baseline spans. Pilot's raw events live under that run's isolated
`home/.loongsuite-pilot/logs/qwenpaw/`. The report compares structural coverage,
not token/timing equality: independent real model requests naturally differ.
The harness directly constructs the official shared WorkspaceBootstrapFactory
and WorkspaceRegistry used by Web/ACP startup. It does not exercise the
AgentCore container build, runtime HTTP adapter, cloud authorization, or CMS
readback. Install Pilot, consume the captured events, and validate actual OTLP
output separately before claiming complete end-to-end delivery.

For actual OTLP/HTTP wire capture, start the receiver with the baseline venv:

```bash
/tmp/qwenpaw-pilot-ab-example/baseline/venv/bin/python scripts/e2e/qwenpaw-parity/receiver.py \
  --root /tmp/qwenpaw-pilot-ab-example/otlp-wire
```

Its `endpoint.json` identifies the ephemeral loopback endpoint. Pass it to the
baseline runner using `--otlp-endpoint`, and configure the installed Pilot OTLP
trace exporter with the same URL and service name `qwenpaw-parity-pilot`. The
receiver preserves original protobuf bodies and decoded OTLP JSON, separated
by `service.name`. It supports HTTP chunked bodies and protobuf/JSON, binds only
to loopback, and records transport content headers without authorization headers.

Compare both actual OTLP wire exports with:

```bash
python3 scripts/e2e/qwenpaw-parity/compare.py \
  --baseline-wire /tmp/qwenpaw-pilot-ab-example/otlp-wire/qwenpaw-parity-baseline.jsonl \
  --pilot-wire /tmp/qwenpaw-pilot-ab-example/otlp-wire/qwenpaw-parity-pilot-qwenpaw.jsonl \
  --output /tmp/qwenpaw-pilot-ab-example/wire-comparison.json
```

Wire comparison checks foreground parent edges and session isolation, nonempty
LLM content, token presence, streaming TTFT bounds, absent nonstream TTFT,
provider/tool errors, cancellation, and Dream owner attribution. Its field-gap
section lists every baseline attribute absent from Pilot for review; it does
not silently treat legacy `copaw.*` keys as required product behavior. Independent
Dream executions may use different numbers of reasoning/tool calls. A known
baseline cancellation child interval can exceed its already-ended ENTRY; such
baseline timing findings are reported separately from Pilot validation.

For a cancellation-only regression, use `--cancel-only` without `--matrix`.
For an isolated real Skill call, use `--skill-only` without `--matrix`. It creates
and enables a synthetic skill through QwenPaw's native SkillService, asks the
real model to invoke the Skill tool, and captures name, runtime-scoped id,
description, and version. Use a separate run root and wire receiver directory
for supplemental scenarios so they do not change the main matrix's counts.
The runner explicitly sets `LOONGSUITE_PILOT_DATA_DIR` to the run's isolated
home, overriding an installed plugin's managed deployment marker. If a wire
file contains a separately run supplemental session, `--exclude-session NAME`
selects the main matrix and records that exclusion in the comparison report.

For a larger real-model workload, use `--extended` in a fresh run root. It sends
six concurrent requests with distinct sessions and response markers, three
successive turns in one session that refer to the previous response, one request
to read three synthetic files, and one request to read an index followed by the
file named in that index. These eleven requests use the official Runtime and
provider; tools only read isolated synthetic files. Scenario results include
the expected response markers for independent verification. Model/tool call
counts can differ between independent runs; compare actual content, coverage,
parent relationships, and telemetry completeness before treating count
differences as a defect.

## Native Pilot visual verification matrix

Run `--visual-matrix` with a fresh isolated root and the **installed** plugin:

```bash
/path/to/venv/bin/python scripts/e2e/qwenpaw-parity/run_runtime.py \
  --root /tmp/qwenpaw-visual/runtime-main --mode pilot --visual-matrix \
  --plugin /path/to/installed/assets/plugins/qwenpaw/loongsuite-pilot
```

This matrix uses no AgentCore request context. It covers a two-turn conversation
with sequential file lookups and multiple tools, nonstreaming, three concurrent
independent tool sessions, breaking at the terminal response then immediately
starting another turn, consumption from different asyncio Tasks, missing-file
errors, cancellation, and healthy calls following lifecycle edge cases. The
writer fault case temporarily points the plugin at a regular file so actual
filesystem writes fail; the business call still uses the real model. Restoring
the path then exercises telemetry recovery. The fault request intentionally has
no Pilot events and must be labelled business-isolation evidence, not successful
telemetry delivery.

`outcomes.jsonl` preserves each completed scenario immediately. `results.json`
records final user-visible output, expected marker checks, native request/model/
tool observer counts, terminal status, and non-sensitive ContextVar state before
and after consumption. Retain raw `runtime-events.jsonl` and `contract.jsonl` to
verify those summaries independently. These summaries do not assert cloud or
trace-tree correctness: correlate exact sessions and trace IDs after collecting
and reading back the events. Cross-Task consumption tests a native framework
boundary too; an unsupported native path must be investigated separately from a
probe failure. Do not infer success from a process exit code alone.

The visual matrix also injects one real exception in the loaded plugin's
`_messages` mapper, restores the function in `finally`, and immediately performs
another healthy request. `mapping-fault.json` records the injection count;
provider calls and responses are never replaced. `request_id` is set on the
native request and retained in outcomes/raw events for exact `gen_ai.turn.id`
correlation. `final_text` is only the last assistant text message;
`all_assistant_text` preserves intermediate assistant messages for diagnosis.
Use `--complex-only` to repeat just the two tool-rich turns in a fresh root.

For independent OS processes, run `--smoke-only` concurrently with separate
`--root` directories, unique `--session-prefix` values, and one shared
`--pilot-data-dir` monitored by the installed collector. Each process creates
its own QwenPaw workspace/secrets but writes native plugin events into that
shared directory using separate PID files. Each smoke makes a real model/tool/
model request reading only its isolated witness file. Metadata records the
actual native context strategy; do not attribute framework context behavior to
Pilot solely from a model failing to complete a requested task.

Use `--mode probe --lifecycle-only` without `--plugin` in a fresh root for a
native no-Pilot control of the same four terminal-break/cross-Task requests.
The observer remains enabled to count real business calls, but no Pilot plugin
is loaded. Compare raw stderr as well as outputs and context state; native
async-generator close errors must not be hidden by successful marker checks.

Use `--mapping-only` for the entry message-mapping failure and following healthy request. The failure deliberately omits ENTRY content, but must preserve its native request/session identity and child relationships. The harness locates either the supplied plugin or the copy installed by newer PluginLoader versions.
