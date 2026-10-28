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

Executions extending outside the observed request retain their boundaries, identities, I/O and collected tools in canonical logs without exporting uncontained TASK spans. The adapter neither stretches the request nor invents ENTRY/AGENT ancestors. Late-arriving metadata whose actual interval is contained can still join the original tree; genuinely out-of-request background work is reported separately.

Late parent records receive a grace period; successful parent Write/Edit evidence retains the wait within existing state limits. Missing/ambiguous parents retain source identity and resolution metadata without synthetic spans. The client persists executions with tracked file mutations only: read-only or cloud-only child work may have logs but no TASK.

## Content and reliability

Read only the exact fresh conversation in up to 16 `Default` / `Profile N` directories; duplicate profile matches remain ambiguous. No history enumeration, authentication stores, cookies or snapshot file bodies are read. Unique assignments, native user delimiters and exact current tool IDs select the current outputs. LLM inputs may retain earlier visible messages in that conversation as context, without re-exporting old assistant rows as current LLMs. Native content fields and each round's input are limited to 64 KiB; old complete input messages may be removed. Reconstruction caps each owner at 64 assistant rounds and 512 KiB of expanded content, recording omitted counts. Adjacent duplicate tool-free final messages become one visible round.

A current assignment with a not-yet-persisted final row allows up to two seconds of telemetry-only settling, then falls back without changing existing source request/tool times or blocking the app. Exact native tool names are retained separately from callback executor names (for example native PowerShell versus callback Bash). Expanded history and tools pass through recursive InputManager masking before Span serialization; internal reconstruction content is not duplicated into JSONL.

All content passes through InputManager's regular recursive masking before conversion. Each owning request or local TASK exports at most 64 local TOOL spans; `tool_observations_not_in_span` reports omitted observations, while collected canonical facts remain in JSONL. Partial, conflicting or nonpositive callback intervals are not completed observations.

Native scans are bounded to one known conversation, 64 Agents, 2 MiB per file, 8 MiB total, ancestry depth 8. Snapshot scans separately cap 8 account directories, 128 executions/files and 8 MiB. Symlinks and directory escapes are rejected. Incremental logs retain complete-line offsets and fingerprints across restart, rotation, truncation and transient read failures. First start skips history. Per read/cycle limits are 1/8 MiB and 128 log files. Request/sandbox state is bounded to 512 records / 24 hours, pending tools to 4096 / 24 hours, completed IDs to 4096 / 7 days. Native scans run at most once per 10 seconds. End-to-end exactly-once is not promised.

## Configuration and acceptance

| Platform | Source log |
|---|---|
| macOS | `~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log` |
| Windows | `%LOCALAPPDATA%/DoubaoWork/User Data/sdk_storage/log/saman_YYYY.MMDD.N.log` |

Windows falls back to `~/AppData/Local`; macOS retains microsecond and Windows millisecond source precision. Optional `listeners.doubao-work.logDir` overrides the read-only source, independently of output `dataDir`.

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

The Agent definition is detection-only. Disabling the Agent/listener stops collection. Runtime Skill loading, the separate cloud partner page and complete cloud invocation lifecycles remain uncovered.

Fresh native acceptance separately verifies source, canonical JSONL, OTLP and CMS, including round I/O, parallel batches, tool ID/time/ownership, unique TASKs and asynchronous links. A complete visible root transcript produces ENTRY → AGENT → STEP → LLM / TOOL. Local-execution fragments keep their STEP under their owning TASK, without pretending to cover a full cloud Agent invocation. Tools without a usable transcript keep direct AGENT/TASK ownership and the `genai.observed-tools.v1` partial-observation contract. Canonical call/result logs remain; exported tools are not also duplicated as parent Span events.

The complete Pilot ReAct validator remains unchanged, without product exceptions. Direct tools lacking a transcript and local STEP-under-TASK fragments may still fail its complete-Agent topology; retain those findings and attribute gaps. Content/timing-algorithm validation does not certify measured model telemetry. Also read back the actual effect on default CMS LLM counts and latency statistics. Out-of-request background executions remain incomplete.

Local observations use `local_execution_phase` and `root_turn_id`, without client `gen_ai.turn.start/end` or a synthetic client turn.
