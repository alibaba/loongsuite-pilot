# OpenClaw compatibility acceptance

## Automatic entry follow-up — validation scope

The follow-up on `fix/openclaw-auto-entry` removes mandatory `OPENCLAW_CLI_PATH`
for unambiguous cwd/PATH/bundle installations and persists the selected entry
in Pilot config. See [current deployment contract](agents.md#openclaw-compatibility-and-lifecycle).
It also preserves existing OpenClaw state after default-selection discovery
failures and avoids rewriting an already-correct plugin configuration.

The historical Gateway/SLS runs below tested the earlier explicit-entry
contract, **not this follow-up**. They must not be reused as proof of automatic
entry installation, service-environment persistence or EDR acceptance. New
automated coverage executes both installers' config-writing logic, then checks
fresh-service discovery, legacy/modern permissions, ambiguous/missing entries,
default versus explicit selection, and byte/mtime idempotence in isolated files.
Real Gateway PID continuity, native Windows service startup and EDR backend
alerts require separate installed-product validation.

## Historical reviewer closeout — 2026-09-08

**PASS for the tested head:** real OpenClaw 2026.3.8 and 2026.6.10 Gateway,
public Pilot installer, strict canonical JSONL validation and independent
CMS/XTrace SLS readback. Native sender on 3.8 remains out of scope.

### Fix and deployment contract

- Runtime fix: `ca132f668f5129b325122f00c8a9afc79b691b94`.
- The installer and collector/watchdog require an absolute `OPENCLAW_CLI_PATH`
  identifying the actual Gateway entry. For `WORKDIR /app` and
  `node openclaw.mjs gateway ...`, set `/app/openclaw.mjs` in their shared
  container environment before normal installation/start. No version argument.
- PATH/cwd/bundle-only discovery is diagnostic, not deployment authority.
  Unbound, missing, relative, invalid or unsupported entries leave config
  unchanged and remain non-ready/retryable, even with a modern CLI on PATH.
  This also applies after the collector loses its binding on restart.
- Version detection reads the bound installation's metadata, without a CLI,
  shell, package manager, procfs scan or runtime permission bootstrap.
  No Gateway reload/restart is introduced by this compatibility fix. Applying
  a new environment to an existing container may still require redeployment.
- Legacy and modern `gen_ai.system_instructions` now use canonical text-part
  arrays. Content-off still removes them.

### Exact target and execution

- Tested immutable head: `799c2692acb10be74154999259e615d5d05c87c7`.
  Its only delta from the runtime fix is an E2E evidence-drain correction.
  Subsequent documentation-only commits do not change the tested runtime.
  This is head acceptance, **not** a claim that a moving PR merge ref was tested.
- PR base reported during this review: `4631bd760a586e9ac4e79bd992f6ffc120334f96`.
- Candidate image: `4c19b3924cd3eacae0220013633340467bdada1bd9c3798a9b1271c701818b24`.
- Linux arm64, Node 22.23.2, disposable Podman containers; no host Pilot changes.
- Real provider: DeepSeek `deepseek-v4-flash`, `https://api.deepseek.com`.
  Runtime secrets only; no credential in source, images or archived evidence.
- CMS workspace `pilot-e2e-test`, XTrace region `cn-hongkong`. No new ARMS UI
  inspection or official OpenAI endpoint acceptance is claimed in this round.

Both containers contain a real `/app` package directory and launch
`node openclaw.mjs gateway --allow-unconfigured --bind loopback --port 18789`
from `/app`. Native token authentication remains enabled. Loopback isolates the
test instead of using the customer's LAN bind; no wrapper replaces Gateway.
The installer runs outside `/app`, and collector restart keeps the binding.

| Actual Gateway | PATH candidate | Run ID / service suffix | Events | Native LLM calls / tools | SLS traces / spans |
| --- | --- | --- | ---: | ---: | ---: |
| 2026.3.8 | 2026.6.10 | `oc-binding-final-38` | 39 | 6 / 4 | 4 / 24 |
| 2026.6.10 | 2026.3.8 | `oc-binding-final-610` | 47 | 6 / 4 | 4 / 24 |

Exact service names are `pilot-openclaw-gateway-` plus the run ID.
SLS query windows (Asia/Shanghai, 2026-09-08): 14:13:19–14:18:21 for 3.8 and
14:13:21–14:18:20 for 6.10. All local/backend span identities, parents,
timestamps, per-call input/output/cache tokens and worker metadata agree.

| Version | Release package SHA-256 |
| --- | --- |
| 3.8 | `6ee5ff17cf1190f29de08c8500d086641f70829862a3968c05968e20f63d7fb8` |
| 6.10 | `787aba86081c4566746760eed5993f5fbf28f2ebaf8c3903127f6788ab65025b` |

| Scenario | 3.8 trace ID | 6.10 trace ID |
| --- | --- | --- |
| Text | `089fea5ccb78eb31e0fb40b9c336dfa8` | `0a7964cf4002084ed3f5fdec9972f67b` |
| Two read tools | `d116bffad5c70b677978f65b8909cf33` | `5b4c141a021fa16aa824dfc7c4b38062` |
| Restart | `5cfa2e21387c94310877aff3755a5ed2` | `2c92e37461fb66b7e46731513cbb3ffe` |
| Content-off / missing file | `b57a2c1a0d8152e3646585e9bc4c36b4` | `9374c9d23e29160caa0993a43649672d` |

### Gates and limitations

- Executed on the tested head: typecheck/build PASS; full Linux non-root suite
  **323 files, 4,263 passed, 70 skipped**, no provider credentials or network in
  the final unit-test container. Runtime-fix targeted suite: 11 files, 192 passed.
- Strict JSONL: 39/47 events, **zero errors** for both versions. Modern still
  has 11 non-LLM events with `provider=unknown` reported as placeholder warnings;
  all actual LLM calls have the verified provider/model. These are not new errors.
- System instructions: 9 canonical events and 7 local/backend spans per run
  contain valid text-part arrays; privacy-turn events/spans contain none.
- Text, two-tool, post-restart and content-off/missing-file turns pass. Restart
  keeps native session identity without replay. The restart/privacy scenarios
  deliberately restart the test Gateway; compatibility installation does not.
- Watchdog repairs load paths and version-specific hooks; reinstall is
  idempotent; uninstall preserves unrelated plugin/user settings. Real packaged
  CLI probe also rejects an unbound modern PATH candidate with a diagnostic.
- Every LLM call has positive native input/output/cache usage; agent totals and
  SLS parity pass. 3.8's 6 inferred LLM spans preserve the inference marker.
  No incomplete spans or unexpected error spans; each run has one intentional
  missing-file TOOL error. No persisted OTLP failures.
- First 6.10 attempt `oc-binding-0908-610` remains recorded as **FAIL**: its live
  snapshot raced JSONL fan-out (5 canonical responses vs 6 spans). After shutdown,
  the same archive had all 6 native/canonical responses and 24 coherent spans.
  The harness now stops/drains collection before final evidence validation;
  both fresh final runs above passed. The failed run was not relabelled PASS.
- Windows, EDR, intermediate OpenClaw releases, live version switching and every
  concurrency/cancellation path are not live-certified. Unknown bindings do
  not repair an already-invalid configuration. Legacy standalone session-ID and
  zero-native-token limitations remain unchanged; 3.8 native sender is excluded.

Private evidence is retained by run ID: `result.json`, strict-validator log,
native/Pilot logs, `backend-sls.jsonl`, `backend-validation.json`, and
`extra-validation.json`. Only this sanitized summary is committed.
PR #383 remains Draft for reviewer re-review; this record does not approve,
resolve review threads, merge or release it.

## Historical closeout — 2026-09-07

> The record below applies only to its older frozen runtime. The current
> reviewer fixes and their acceptance are documented above.

## Result and scope

Real Gateway acceptance passed for **2026.3.8** and **2026.6.10**, using
DeepSeek `deepseek-v4-flash` over its native HTTPS endpoint. Both runs passed
independent CMS/XTrace SLS readback. The user separately confirmed ARMS UI display.
No OpenAI-official-endpoint result is claimed or required for this acceptance.

Native sender extraction on 3.8 is explicitly **not supported** in this change.
Configured/environment identity and worker identity remain supported. The new
closeout changes are tests, acceptance tooling and documentation; production
collector/plugin/installer code is unchanged from PR head
`d2c9187e6afa8c7e9835ac206be46af4fe19c123`.

## Frozen runtime and evidence

- PR: [#383](https://github.com/alibaba/loongsuite-pilot/pull/383), issue
  [#382](https://github.com/alibaba/loongsuite-pilot/issues/382).
- Runtime head: `d2c9187e6afa8c7e9835ac206be46af4fe19c123`.
- Base: `4631bd760a586e9ac4e79bd992f6ffc120334f96`.
- Tested runtime merge: `990eb35d83a4956e2aa5f03c7169c91e40838988`.
- Linux arm64, Node 22.23.2, disposable Podman containers. No host Pilot changes.
- CMS workspace: `pilot-e2e-test`, region: `cn-hongkong`.

| OpenClaw | Run ID / exact service suffix | Canonical events | Native LLM responses | Tools | Backend traces / spans |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026.3.8 | `oc-closeout-38-0907c` | 39 | 6 | 4 | 4 / 24 |
| 2026.6.10 | `oc-closeout-610-0907f` | 47 | 6 | 4 | 4 / 24 |

Exact service names are `pilot-openclaw-gateway-` plus the run ID. Each run has
text, two-file tools, post-restart text, and content-off/missing-file turns in one
native session. One TOOL error per run is the expected missing-file result, not a
model or export failure. No unexpected error spans or persisted export failures.

| Version | Evidence identifiers |
| --- | --- |
| 3.8 image ID | `2bf5ddc06226b4a67df4360ffad010545f27b5520754115c79e490164374a7fe` |
| 3.8 package SHA-256 | `be2baa580238e77e3c2e8c5c6b6b2633e08ba9f04b527ce9b0f740927636a9ca` |
| 6.10 image ID | `e1a50e2f096df3af964a8aade936092dd494721e84765efabf5a652004ff3b1a` |
| 6.10 package SHA-256 | `abf7d3c9732bef4cb2918614f10fb8103a9557639770681c1bc0259fdf1c4b0d` |

Trace IDs, in scenario order:

| Scenario | 3.8 | 6.10 |
| --- | --- | --- |
| Text | `db63dbfefe3f468325609778ae06c0e0` | `b4eda1dc47c2621902ff862bca4d9443` |
| Tools | `f0d0822715e76c16acb49f864f3b278f` | `dd8c01158bff88825b43358e8b1b1452` |
| Restart | `869cacbb8a874b183d89acaf16348509` | `b703b10c8b35a55a51d6e4c1d526a4c9` |
| Content-off | `debea60b199bfc617155ca422f6b1de9` | `b41ff37080e96a4612ac4e661a8de228` |

Private evidence is retained under each run ID: `result.json`, native session
JSONL, Pilot raw/canonical/debug logs, installer/uninstaller logs,
`backend-sls.jsonl`, and `backend-validation.json`. Credentials, generated model
configuration and native device-auth state are not archived or committed.

## Gates executed

- Real installer discovers the installed package automatically; 3.8 omits
  `allowConversationAccess`, while 6.10 enables it. Both validate successfully.
- Gateway and Pilot restart retain the native session; historical event IDs and
  native model response counts show no replay.
- Every model response agrees with native input/output/cache usage; AGENT totals
  equal per-call totals. Local/backend span IDs, timestamps and identities agree.
- ENTRY → AGENT → STEP → LLM/TOOL hierarchy and positive nested timing pass.
  Exact service and `AGENTTEAMS_WORKER_NAME` resource/agent names pass.
- Content-off excludes messages, reasoning, tool arguments/results and error
  messages/markers from raw plugin events, canonical events and backend spans.
- Watchdog repairs the removed Pilot load path and incompatible/missing hooks.
  Reinstall is idempotent. Uninstall preserves an unrelated plugin and user config.
- Full local suite: **4,232 passed, 70 skipped** across 320 files. Run as non-root
  with an init process and a Git index; root permission tests and Git inventory
  tests are not meaningful in an archive-only/root test container.
- Typecheck and build passed. Prior head's GitHub Node 18/20/22, CodeQL,
  Secret Scan and CLA checks were green; new-head CI must be checked separately.

The harness assertions have positive/negative regression tests (including no
evidence, replay, token mismatch, topology, worker/service, expected tool errors
and privacy). It is a scoped validator, not a claim that the absent/untracked
`docs/trace-validation-rules.json` full rule set was executed.

## Earlier support and residual limits

| Earlier PR | 3.8 applicability |
| --- | --- |
| #374 | Session lifecycle records stay raw-only; no duplicate canonical input ownership |
| #360 | Identity precedence remains; native sender extraction is out of scope on 3.8 |
| #338 | Worker metadata verified in a real Gateway process and backend spans |

The new standalone `--session-id` correlation limit and native zero-token
DashScope path remain documented; this acceptance is for Gateway with a provider
returning real usage. 3.8 timing remains explicitly inferred, not provider TTFT.
Windows, customer EDR, all intermediate releases, live host-version switching,
and every concurrency/cancellation path were not live-tested. Existing targeted
contract tests are complementary evidence, not substitutes for those environments.

See [reproduction instructions](../scripts/e2e/openclaw-compat.md). Merge and
release remain separate owner actions; this record does not merge or publish.
