# Doubao Work task, tool and subagent observations (experimental)

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
| Subagent local execution fragments | Native sandbox actors identify the root request; matching `create_agent` calls/results prove ancestry. Each settled local tool produces independent child/ancestor AGENT observations, including nesting, reuse, late arrival and checkpoint recovery |
| Full cloud subagent lifecycle | Complete execution boundaries remain unavailable for all Agents. Cloud-only work and Agents without paired local tool callbacks do not produce lifecycle spans |
| Separate workmate page | The aily cloud task surface has a separate lifecycle not covered by these client-message logs |

Local TOOL duration spans client dispatch receipt to execution settlement, including dispatch/approval waiting. It is not cloud invocation latency. Native tool name, call ID, bounded status and positive duration in milliseconds are retained. Commands, arguments, results and raw errors are never read into events. Native `success` describes execution settlement, not business success or a Bash exit code.

`loongsuite.doubao_work.tool_boundary=client_received_to_execution_settled` identifies this contract. With no observed model or React step, the trace is ENTRY → AGENT → TOOL; no STEP/LLM is invented. The candidate validator accepts this exact boundary only for Doubao TOOL children of a Doubao AGENT. Other Agents retain their model/step checks. This source also excludes arguments, which are explicitly reported as not applicable. Older validators requiring STEP → TOOL or unconditional arguments report contract incompatibility; retain their failed result alongside this candidate's documented contract. Ordinary tool argument checks remain strict.

Unpaired, conflicting or ambiguous calls are omitted. Background child tools export independently only with unique native sandbox and creation-graph evidence. Cloud-only `calculator`, `web.fetch` and `create_agent` records without times do not become timed tools. Ordinary request traces do not certify subagent reuse, nesting, late completion or restart.

## Native child fragments

Read-only trajectories are resolved under `Default/.doubaowork/agent_mode/workspace/.sessions/<conversation>/agents/*/system/trajectory.jsonl` relative to the client data root. Only conversations identified by fresh frontend requests are inspected. Matching successful native `create_agent` calls/results must name the caller as parent and form an unambiguous path to one main Agent. Sandbox actors must identify exactly one captured root request and each observed child/ancestor actor.

Each settled local tool is an immutable fragment: ENTRY → root AGENT → organizer AGENT → child AGENT → TOOL. Its exact native receipt/settlement times define the observation. Ancestors cover the same descendant tool interval (`timing_basis=descendant_local_tool`), while the leaf uses `own_local_tool`. A timed dispatch TOOL is not fabricated. This is a partial local execution observation, not the full cloud invocation duration; an Agent can have multiple fragments and ancestor windows must not be summed as extra tool time.

`observation_scope=native_local_tool_fragment`, `agent_boundary=native_local_tool_interval`, `fragment_id` and native Agent/parent/thread/creation-call IDs expose the evidence. `relation_basis=native_create_agent_ancestry` denotes native creation ancestry, not an inferred per-invocation cloud dispatch. Root Span IDs and fragment event/Span IDs are deterministic; late children link after root export without changing its times. Selected root skills are not inherited. Assignment timestamps, board-wide update times, file mtime and historical panel reception are not used as execution boundaries.

Native scans are limited to one known conversation per cycle, 64 Agents, 2 MiB per file, 8 MiB total and depth 8. Transient/incomplete graph reads retain pending tools. Root/sandbox contexts retain up to 512 items/24 hours and fragment deduplication 4096 items/7 days. The validator permits asynchronous direct AGENT ancestry only for this explicit native fragment contract; ordinary topology/timing checks remain strict.

## Native sandbox executions

The native `entry-moa` execution manager generates an execution UUID and persists metadata under `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json`. Its `execution.startedAtMs` is recorded after the native `getOrCreateSandbox` callback; `endedAtMs` is recorded during release after modified-file capture. These exact millisecond fields produce one independent AGENT with `observation_scope=native_sandbox_execution`, `agent_boundary=native_sandbox_get_or_create_to_release`, and `timing_basis=native_execution_startedAtMs_endedAtMs`. Polling time, mtime and tool intervals do not supply these boundaries.

The native query message ID must match a newly observed root local message ID, with consistent native sandbox actors. Creation trajectories establish native Agent ancestry. A parent execution is selected only when exactly one enclosing execution has the native parent Agent identity, the same query and the same sandbox. A successful native parent Write/Edit is retained as checkpointed evidence that its execution snapshot may still arrive; children wait within the existing 24-hour/4096-entry association and root-context bounds, rather than irreversibly falling back at 30 seconds. Without parent mutation evidence a 30-second grace period applies. A missing, ambiguous or non-enclosing parent then links to the observed root request with `parent_resolution=root_request_ancestor`; native parent identity and ancestry remain explicit, without invented intermediate spans. Already exported edges are immutable.

The client persists these snapshots only for executions with tracked file mutations. Pure Read/Bash, cloud-only Agents and missing snapshots have no complete execution coverage. This is a local sandbox lifetime, including release-time capture, not a full cloud inference lifetime or proof of each cloud dispatch. Tool fragments remain a separate observation scope and must not be counted as additional complete invocations.

Only a known fresh conversation is read, with limits of eight account directories, 128 execution files, 2 MiB per file and 8 MiB per cycle. Symlinks are not followed. Account identity, file paths and file contents are never projected into events. Partial/transient reads defer completion; execution deduplication retains 4096 IDs for seven days. Checkpoints acknowledge the InputManager queue boundary, not end-to-end output delivery.

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

Missing logs, changed protocols or missing identity/timing evidence do not generate guessed traces. Only bounded identity/status/creation-graph metadata is extracted. Cookies, credentials and message databases are not read; native trajectory prose, commands, results and raw errors are not exported. Unified identity and masking still apply.

Validate fresh GUI interactions with `E2E_JSONL_STRICT=1` and `E2E_JSONL_AGENT_FILTER=doubao-work`. Passing task/local-tool checks does not establish cloud LLM, runtime Skill or full subagent lifecycle support. Record source, events, spans, receiver and cloud readback separately.
