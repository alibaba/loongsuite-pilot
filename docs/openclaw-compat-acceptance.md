# OpenClaw compatibility closeout — 2026-09-07

> Historical live evidence for the frozen runtime below. Subsequent reviewer
> fixes change deployment, legacy lifecycle/timing and OTLP diagnostic projection;
> this earlier PASS does **not** certify those new runtime changes. Their local
> regression results are reported separately in PR #383. Actual Gateway entry
> binding remains open where the container launches a different installation
> that Pilot cannot discover; the PR is not ready to merge on this record alone.

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
