# Doubao Work client and local execution observations (experimental)

The passive adapter reads the official macOS / Windows client's logs and native files for freshly identified conversations. It installs no hooks and changes neither authentication nor the app. Observed baselines are macOS 2.33.10 / 2.34.1 and Windows 2.25.18. Visible assistant messages reconstruct a content-first STEP / LLM / TOOL tree; provider metadata and complete cloud execution coverage remain unavailable.

## Evidence and projection

| Native evidence | Output |
|---|---|
| Exactly correlated client submit/end | One ENTRY → AGENT pair with source precision, representing the client request |
| Local received/settled callbacks | Exact-ID logs and independent `execute_tool` TOOL spans when complete intervals fit an evidenced owner |
| Unique current assignment | AGENT `gen_ai.input.messages` or TASK `input.value` |
| Final assistant row after current exact call results | AGENT `gen_ai.output.messages` or TASK `output.value` |
| Exact native tool IDs, arguments and results | Tool log / TOOL span content and native decision batch IDs |
| Current assistant rows and preceding visible messages | One STEP and `chat` LLM per assistant decision, with text/tool-call outputs and visible user/assistant/tool history as input; parallel tools share one STEP |
| Complete persisted local sandbox execution UUID and times | One `run_task` TASK per local execution |
| Selected Skill / partner IDs | Request context only, never proof of runtime loading |

Without an unambiguous current transcript the adapter falls back to request/local-tool observations. With a transcript, logical model timing is estimated from client evidence:

- The first round starts at request submission; subsequent rounds start when the preceding tool batch completes. The earliest local tool receipt ends its producing LLM round; the last round uses the confirmed request/local-execution end.
- Existing local tool intervals are unchanged. A native `Wait` result with valid, contained `started_at` / `ended_at` anchors its waiting interval separately.
- Intermediate assistant/tool boundaries without timestamps are linearly placed between adjacent observed anchors. File mtimes and collection times are never used. Contradictory temporal order falls back to separately evidenced tools.

These are ordinary `LLM` / `chat` spans without additional display labels, but **their timing is estimated client-side logical timing, not measured provider inference latency**. Default CMS LLM counts and latency statistics can include these rounds and estimates. Do not interpret them as precise provider performance or actual request counts. Visible history is not the full provider prompt: system instructions, memory, compaction and hidden retries may be absent. Unavailable models, provider response IDs, usage, cost and model finish reasons are omitted. First reasoning-output receipt remains a custom client duration, not model TTFT.

Client success can accompany quota notices, so business outcome remains unknown. Received requests use UNSET status; explicit client failures/cancellation use ERROR. Local settlement and resource release do not prove business success.

## Local TASK relationships

Only complete native `execution` metadata under `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json` supplies local start/end times. Those boundaries cover local sandbox acquisition through release/file capture, not the cloud Agent invocation. Query message ID, conversation, sandbox actors and successful native creation ancestry must all agree.

A unique enclosing execution in the same query/sandbox and within the observed client interval provides a TASK → TASK parent. Other contained local TASKs use their exactly identified owning AGENT as parent, with explicit `trace_parent_resolution`. A redundant Span Link retains origin context, but the tree does not depend on backend Link storage. Creator identity remains metadata, not a fabricated cloud invocation parent.

Executions crossing the client request's end, including those starting after it, produce an independent deterministic trace rooted at their actual local TASK. A Span Link plus queryable `origin_trace_id` / `origin_span_id` retain the originating AGENT context; canonical execution facts retain the original request trace ID. Contained LLM/STEP/TOOL spans use the independent trace identity and preserve execution/tool source times. The adapter neither stretches the request nor invents ENTRY/AGENT ancestors. Late-arriving metadata whose actual interval is contained still joins the original tree. Execution starts preceding the originating request and conflicting identity/boundary evidence remain rejected.

Contained children wait 30 seconds for parent metadata, extended to 120 seconds from first observation only by source-timed parent Write/Edit success within this request. A successful same-content write need not produce a snapshot: after the bounded grace, fall back to the known request owner without manufacturing a parent. Legacy checkpoint witnesses without source time do not extend the wait. Independent background roots do not wait for parent snapshots. Missing/ambiguous parents retain source identity and resolution metadata. The client persists executions with tracked file mutations only: read-only or cloud-only child work may have logs but no TASK.

## Content and reliability

Read only the exact fresh conversation in up to 16 `Default` / `Profile N` directories; duplicate profile matches remain ambiguous. The adapter does not enumerate history or read authentication stores or cookies. Business file bodies inside snapshots are not collected; the first metadata parse still reads the bounded snapshot JSON. Unique assignments, native user delimiters and exact current tool IDs select the current outputs. LLM inputs may retain earlier visible messages in that conversation as context, without re-exporting old assistant rows as current LLMs. Native content fields and each round's input are limited to 64 KiB; old complete input messages may be removed. Reconstruction caps each owner at 64 assistant rounds and 512 KiB of expanded content, recording omitted counts. Adjacent duplicate tool-free final messages become one visible round.

The client's `skill://<name>?...` and expanded absolute `.doubaowork/agent_mode/workspace/.skills/<name>/SKILL.md` or App `.doubao/...` links are matched by Skill identity and label. Other instruction text must still agree; ambiguous delimiters, unrelated links and arbitrary paths are not fuzzy-matched. Original message content remains unchanged, without duplicating the assignment alongside its expanded user message.

On reuse, complete leading native `system-reminder` blocks and their blank separators are normalized only for assignment/user-row matching. A separate reminder sharing the demand timestamp is ignored only beside one actual demand with a visible matching user delimiter. Multiple real demands, a reminder-shaped user message, missing reused delimiters and malformed blocks still prevent reconstruction. Captured input/output, row positions, round IDs, tool ownership and source times are not rewritten.

Requests lacking a source terminal remain pending; navigation, first output and collection time never manufacture completion. Bounded completion scans rotate with a persisted cursor, so incomplete requests or invalid terminals cannot starve later complete requests, including after restart.

A current assignment with a not-yet-persisted final row allows up to two seconds of telemetry-only settling, then falls back without changing existing source request/tool times or blocking the app. Exact native tool names are retained separately from callback executor names (for example native PowerShell versus callback Bash). Expanded history and tools pass through recursive InputManager masking before Span serialization; internal reconstruction content is not duplicated into JSONL.

All content passes through InputManager's regular recursive masking before conversion. Each owning request or local TASK exports at most 64 local TOOL spans; `tool_observations_not_in_span` reports omitted observations, while collected canonical facts remain in JSONL. Partial, conflicting or nonpositive callback intervals are not completed observations.

Background native scans cover one known conversation, 64 Agents and ancestry depth 8. Snapshot scans cap 8 account directories, 128 executions/files and 2 MiB per snapshot. Total trajectory size is no longer capped at 2 MiB; incremental limits are described below. Symlinks and directory escapes are rejected. Incremental logs retain complete-line offsets and fingerprints across restart, rotation, truncation and transient read failures. First start skips history. Per read/cycle limits are 1/8 MiB and 128 log files. Request/sandbox state is bounded to 512 records / 24 hours, pending tools to 4096 / 24 hours, completed IDs to 4096 / 7 days. Native scans run at most once per 10 seconds. End-to-end exactly-once is not promised.

## Incremental processing and performance limits

Logs, native sources and round reconstruction share an 8 MiB read allowance, 4096 decoded/reconstruction work units and a cooperative 50 ms target per cycle. Native reads use 64 KiB chunks and processing yields every 256 units. Exhaustion preserves progress for later cycles rather than returning empty evidence. Multi-file log sweeps retain their current position; a drained window that consumed the budget gives finalization a fresh cycle, preventing later-file or completion starvation. File operations, individual JSON decodes and finalization can exceed this cooperative time target.

Native parsing is reused by file identity, size and nanosecond modification/change markers. Unchanged sources require no body opens/reads. Appends verify first/tail anchors; rewrites, truncation, replacement or conflicting markers invalidate the cache. JSONL consumes complete lines only. Metadata times never supply semantic timestamps.

Each actor retains a roughly 2 MiB recent body window with original source positions. Creation ancestry and bounded call indexes are maintained separately. Older input may be truncated; if the current demand delimiter has left the window, ownership is not guessed. Individual JSONL records remain limited to 2 MiB and call indexes to 4096 entries, with explicit degradation diagnostics.

Native caches cap at 512 files and an estimated 64 MiB, expiring inactive entries after 15 minutes. Inactive conversations are evicted first, then the oldest active entry, protecting the current scan temporarily; a protected conversation that alone exceeds capacity degrades explicitly. Estimated cache bytes are not a process RSS guarantee. Completed snapshots retain execution metadata only, discarding body buffers.

Round inputs use a byte-counted message window instead of repeatedly serializing all history. Up to four resumable jobs retain an estimated 32 MiB for 60 seconds, freezing validated source views while processing long current turns across cycles. Existing IDs, original row positions, 64 KiB inputs and 64-round/512 KiB output limits remain.

Native bodies and reconstruction progress are memory-only. Restart rereads confirmed conversations cooperatively, using durable log cursors, pending state and deterministic completion IDs for recovery. Output queuing and checkpoint ordering are unchanged. Checkpoints are committed only when cursors, relationships, completions or TTL cleanup actually change; idle polls neither deep-copy nor rewrite state.

The `Doubao Work native cache statistics` debug log reports cumulative body reads, parsed lines, hits, resets, evictions, estimated retained bytes and file counts. Runtime input metrics also include native reads; metadata queries still cost work. Content passes through the shared masking pipeline.

Run `node tests/performance/doubao-work-rounds.perf.mjs` for isolated 4k/8k/16k synthetic-history wall/CPU, timer-delay and RSS measurements. These measure collector reconstruction, not customer model response time.

## Configuration and acceptance

| Platform | Source log |
|---|---|
| macOS | `~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log` |
| Windows | `%LOCALAPPDATA%/DoubaoWork/User Data/sdk_storage/log/saman_YYYY.MMDD.N.log` |

Windows falls back to `~/AppData/Local`; macOS retains microsecond and Windows millisecond source precision. Optional `listeners.doubao-work.logDir` overrides the read-only source, independently of output `dataDir`.

Recognized `saman_frontend_*` / `FRONTEND` records support the observed six-digit microsecond and Windows App three-digit millisecond timestamps. `saman_*` / `CONSOLE` records retain three-digit millisecond timestamps; mismatched producers and unsupported precision remain rejected.

Newer Windows App dispatcher starts (`agent_sandbox_toolcall_exec`, `status: start`) supply explicit actor, sandbox and tool-call IDs. They pair with the existing `execution_settled` result; telemetry success/error duplicates do not replace that result. Native graph and execution identity checks still govern child association.

Doubao App work mode and Doubao Work are independent products. A default installation discovers both automatically and collects them concurrently in one Pilot process. App uses Agent/listener ID `doubao`; Work uses `doubao-work`. Both instantiate the same `DoubaoWorkInput` and share native parsers and Trace conversion, so protocol fixes do not need to be copied between implementations.

App roots are `~/Library/Application Support/Doubao` on macOS and `%LOCALAPPDATA%/Doubao/User Data` on Windows, with namespace `.doubao`; Work uses `DoubaoWork` and `.doubaowork`. Watchers, checkpoints, caches and request identities remain separate. First discovery baselines each product's existing logs and collects subsequent requests. When both entrances are enabled, each receives half the existing read, work, native-cache and reconstruction-queue budgets. These cooperative limits are not a hard CPU/RSS bound.

The following configuration is optional. Disabling one product does not disable the other. Each listener's `logDir` overrides only its log reading, watching and detection path; native sessions and snapshots stay bound to its product. Installer probing, `deploy --require doubao` / `doubao-work` and collector discovery use the same path resolution.

```json
{
  "agents": { "doubao": { "enabled": true }, "doubao-work": { "enabled": true } },
  "listeners": {
    "doubao": { "enabled": true, "pollInterval": 10000 },
    "doubao-work": { "enabled": true, "pollInterval": 10000 }
  }
}
```

Explicit legacy `listeners.doubao-work.client` retains single-product behavior: `doubao-work` does not enable App by default, and `doubao` collects App through the old entrance while suppressing the new one to prevent duplicates. To collect both, finish existing tasks, stop Pilot, back up and merge the configuration, and remove the old `client`. Move an App-specific log override to `listeners.doubao.logDir`. An old App checkpoint transfers to the independent `doubao` state, retaining pending requests and deduplication. Unlabeled legacy state still belongs to Work. Upgrades do not override explicit disablement or installer Agent selection.

The independent listeners use `doubao` and `doubao-work` for `gen_ai.agent.type`, `gen_ai.framework`, fallback Agent IDs, and Agent-derived service name suffixes. The legacy App listener keeps `doubao-work` for these fields and continues to use that Agent's content policy. `loongsuite.doubao_work.client` identifies the source product in either mode. Native main and child Agent IDs retain their source values.

The App work mode was exercised with real macOS and Windows clients on 2026-10-30, covering tools, menu-selected Skills, parallel/background subagents and reuse. Multiple real demands remain ambiguous even with identical text or timestamps.

### Doubao App ordinary chat

Ordinary text chat uses the default `doubao` listener. Client lifecycle logs provide request UUIDs, conversation and message IDs, and submit/receive boundaries. Request messages come from the task store under `Profile */IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb`. Pilot passively reads Chromium WALs and immutable SSTables, validates checksums and fragments, and correlates all native message identities. Pending requests survive late writes, partial records, temporary failures and collector restart.

The client stores active requests and clears the task store after responses finish. Pilot retains observed request messages from WALs and SSTables, selecting the latest observation for each task-store key and request UUID. Exact conversation/message identities and client time boundaries bind the observation to the pending request. Empty stores and store-key cleanup preserve observed requests, while explicit same-request updates replace their previous state. Corrupt or unsupported task-store records keep collection pending, and unrelated later requests leave that protection in place. Content already removed by database compaction can remain unavailable.

Text input/output exports as ENTRY → AGENT → STEP → LLM through the existing identity, content policy and masking pipeline. LLM timing uses client submission through `on_message_receiving_end`, recorded in `loongsuite.doubao_work.timing_basis`. The internal model enum remains a source-specific attribute. Provider model names and token usage require further source support. Real validation on 2026-11-23 covered macOS App 2.34.6 and Windows App 2.35.8 text chat, subsequent turns, cancellation and collector restart recovery. Database and object-store IDs are assigned by each local IndexedDB installation. The reader decodes their key-prefix lengths and retains the data-index and task-store-name checks. Mixed tool/document blocks in ordinary chat require further adaptation. A long-form writing request that the client converted into document work remained pending. Windows 2.35.8 work-mode validation confirmed local write/read execution and tool observations, with native work-trajectory message content still unavailable.

Chat reads share the existing collection-cycle budget. Limits include 32 WAL/table files, 8 MiB per logical record or table, 512 KiB per text field, and 128 projected tasks per source. Content cache capacity is 16 MiB, halved when both products run, with up to 8 MiB additional temporary table-decoding space. Unchanged WALs only verify a small anchor, and unchanged tables require no body reads. Raw task objects and content caches remain in memory.

The Agent definition is detection-only. Disabling the Agent/listener stops collection. Runtime Skill loading, the separate cloud partner page and complete cloud invocation lifecycles remain uncovered.

Fresh native acceptance separately verifies source, canonical JSONL, OTLP and CMS, including round I/O, parallel batches, tool ID/time/ownership, unique TASKs and asynchronous links. A complete visible root transcript produces ENTRY → AGENT → STEP → LLM / TOOL. Local-execution fragments keep their STEP under their owning TASK, without pretending to cover a full cloud Agent invocation. Tools without a usable transcript keep direct AGENT/TASK ownership and the `genai.observed-tools.v1` partial-observation contract. Canonical call/result logs remain; exported tools are not also duplicated as parent Span events.

The complete Pilot ReAct validator remains unchanged, without product exceptions. Direct tools lacking a transcript, local STEP-under-TASK fragments and independent TASK roots may still fail its complete-Agent topology. Independent resource executions are partial observations, not complete cloud Agent invocations; retain those findings and attribute gaps. Content/timing-algorithm validation does not certify measured model telemetry. Also read back the actual effect on default CMS LLM counts and latency statistics.

Local observations use `local_execution_phase` and `root_turn_id`, without client `gen_ai.turn.start/end` or a synthetic client turn.
