# Doubao Work task and local tool observability (experimental)

The `doubao-work` adapter passively reads macOS Doubao Work frontend logs. It installs no host hooks, plugins or connectors and does not change authentication or client settings. The observed protocol baseline is DoubaoWork 2.33.10. Ordinary Doubao, Windows and cloud-internal execution are outside this initial scope.

## Observed behavior

Pilot associates client request submission with the corresponding client message-session end, producing two `other` boundary events and an ENTRY → AGENT trace. Source submission and client log timestamps define the boundaries; Submission retains source millisecond precision and log boundaries retain source microsecond precision. This observes a client request, not completion of every cloud task or internal step.

The adapter does not extract prompts, replies, reasoning, tool arguments/results or generate LLM spans, model identifiers, tokens, cost or model TTFT. The automatic model selector is not a model identifier; SSE/render latency is not native model TTFT.

A capacity or subscription notice can coexist with `session_success=1`. Business outcome therefore remains `unknown`. Received/ended requests use UNSET root status; explicit client errors/cancellation use ERROR. This does not infer business success.

Events and OTLP resources carry three bounded attributes:

| Attribute | Values |
|---|---|
| `loongsuite.doubao_work.observation_scope` | `client_message` |
| `loongsuite.doubao_work.business_outcome` | `unknown` |
| `loongsuite.doubao_work.client_outcome` | `received`, `ended`, `error`, `cancelled` |

Agent type/framework is `doubao-work`, system is `doubao`, and provider is `bytedance.doubao`. Native conversation and per-request session IDs identify the session and turn. User attribution uses Pilot's configured identity/hostname fallback, not device IDs or cache-directory hashes.

## Tools, skills and delegated Agents

| Capability | Observed scope |
|---|---|
| Local tools | Match native frontend `toolcall` receipt and execution settlement by call ID and sandbox; emit paired events and TOOL children of AGENT, including parallel calls and collector restart recovery |
| Selected skills/partners | Bounded native `mention_skill_list` / `mention_partner_list` identifiers appear as `loongsuite.doubao_work.selected_skills` / `selected_partners`; request context only |
| Runtime Skill loading | No verified independent load boundaries; selection does not produce `skill.use` or a skill TOOL span |
| Cloud tools/subagents | Real `create_agent` → organizer → two parallel subagents was verified. Local trajectories contain IDs and parent relationships, but lack execution times and reliable request association; no guessed cloud TOOL/AGENT spans |
| Separate workmate page | The aily cloud task surface has a separate lifecycle not covered by these client-message logs |

Local TOOL duration spans client dispatch receipt to execution settlement, including dispatch/approval waiting. It is not cloud invocation latency. Native tool name, call ID, bounded status and positive duration in milliseconds are retained. Commands, arguments, results and raw errors are never read into events. Native `success` describes execution settlement, not business success or a Bash exit code.

`loongsuite.doubao_work.tool_boundary=client_received_to_execution_settled` identifies this contract. With no observed model or React step, the trace is ENTRY → AGENT → TOOL; no STEP/LLM is invented. The candidate validator accepts this exact boundary only for Doubao TOOL children of a Doubao AGENT. Other Agents retain their model/step checks. Older validators that require STEP → TOOL report structural incompatibility; retain that result alongside validation against this candidate's documented contract.

Unpaired, conflicting, ambiguous or out-of-request background calls are omitted with bounded warnings. Cloud-only `calculator`, `web.fetch` and `create_agent` records without times do not become timed tools. Ordinary request traces do not certify subagent reuse, nesting, late completion or restart.

## Configuration

The default source is `~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log`. The client must already produce frontend logs; Pilot does not enable debug logging. On first activation, existing logs are baselined; only subsequently observed request boundaries are collected.

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

Optional `listeners.doubao-work.logDir` overrides the read-only source directory and supports `~`. It is independent of Pilot's output `dataDir`. The Agent definition uses `detection-only`; disabling the Agent/listener stops collection without any host hook to uninstall.

File notifications wake collection with polling fallback. Checkpoints retain complete-line offsets, boundary fingerprints, pending requests and completed identities. Half-lines, restart, rotation, truncate-and-regrow and temporary read failures preserve incremental state. A response alone does not reconstruct an unobserved historical start. Reads are bounded to 1 MiB each, 8 MiB per cycle and the latest 128 log files. Oversized lines are skipped through their newline. Pending requests are limited to 512/24 hours; tool pairing to 4096/24 hours; completed deduplication to 4096/7 days. These limits do not provide complete capture or end-to-end exactly-once.

Missing logs, changed protocols or missing identity/timing evidence do not generate guessed traces. Only bounded metadata is retained; the adapter does not read cookies, credentials, message databases or user workspace files. Unified identity and masking still apply.

Validate fresh GUI interactions with `E2E_JSONL_STRICT=1` and `E2E_JSONL_AGENT_FILTER=doubao-work`. Passing task/local-tool checks does not establish cloud LLM, runtime Skill or subagent trace support. Record source, events, spans, receiver and cloud readback separately.
