# Doubao Work client and local execution observations (experimental)

The passive adapter reads the official macOS / Windows client's logs and native files for freshly identified conversations. It installs no hooks and changes neither authentication nor the app. Observed baselines are macOS 2.33.10 and Windows 2.25.18. This is partial telemetry with explicit coverage gaps.

## Evidence and projection

| Native evidence | Output |
|---|---|
| Exactly correlated client submit/end | One ENTRY → AGENT pair with source precision, representing the client request |
| Local received/settled callbacks | Exact-ID `tool.call` / `tool.result` logs; timestamped Span events on the evidenced owner |
| Unique current assignment | AGENT `gen_ai.input.messages` or TASK `input.value` |
| Final assistant row after current exact call results | AGENT `gen_ai.output.messages` or TASK `output.value` |
| Exact native tool IDs, arguments and results | Tool log / Span event content and native decision batch IDs |
| Complete persisted local sandbox execution UUID and times | One `run_task` TASK per local execution |
| Selected Skill / partner IDs | Request context only, never proof of runtime loading |

Model identity, usage and individual model/ReAct boundaries are unavailable. No STEP, LLM or TOOL spans are fabricated from gaps between tools, file timestamps, assignments, resumed UI sessions or first output. Native parallel calls share a decision ID, not an invented timed STEP. First reasoning-output receipt contributes only the custom client duration `client_time_to_first_cot_ms`, not model TTFT.

Client success can accompany quota notices, so business outcome remains unknown. Received requests use UNSET status; explicit client failures/cancellation use ERROR. Local settlement and resource release do not prove business success.

## Local TASK relationships

Only complete native `execution` metadata under `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json` supplies local start/end times. Those boundaries cover local sandbox acquisition through release/file capture, not the cloud Agent invocation. Query message ID, conversation, sandbox actors and successful native creation ancestry must all agree.

A unique enclosing execution in the same query and sandbox provides a TASK → TASK parent. Otherwise the local root TASK has a Span Link to the origin AGENT; it neither invents a delegation TOOL/AGENT nor stretches the ended client request. The trace may therefore contain an ENTRY root and local TASK roots. Creator identity is metadata, not invocation-parent evidence. Tools attach only to their exact actor/sandbox within the observed execution; ancestors never duplicate descendant tools.

Late parent records receive a grace period; successful parent Write/Edit evidence retains the wait within existing state limits. Missing/ambiguous parents retain source identity and resolution metadata without synthetic spans. The client persists executions with tracked file mutations only: read-only or cloud-only child work may have logs but no TASK.

## Content and reliability

Read only the exact fresh conversation in up to 16 `Default` / `Profile N` directories; duplicate profile matches remain ambiguous. No history enumeration, authentication stores, cookies or snapshot file bodies are read. Assignments must uniquely match the current request window. Old tails, future/different assignments and unprovable reuse omit I/O rather than carry content across requests. Each content field is limited to 64 KiB. A current assignment with a not-yet-persisted final row allows up to two seconds of telemetry-only settling, then falls back without changing source span times or blocking the app. Exact native tool names are retained separately from callback executor names (for example native PowerShell versus callback Bash).

All content passes through InputManager's regular recursive masking before conversion. Each Span contains at most 64 tool pairs; `tool_observations_not_in_span` reports omitted observations, while collected canonical facts remain in JSONL. Partial, conflicting or nonpositive callback intervals are not completed observations.

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

Fresh native acceptance separately verifies source, canonical JSONL, OTLP and CMS, including I/O isolation, tool ID/time/ownership, unique TASKs and asynchronous links. The generic Trace validator retains strict ENTRY → AGENT, AGENT → STEP and STEP → LLM / TOOL rules, with no Doubao exemptions. Structural validity of the observed subset does not imply full ReAct coverage.
