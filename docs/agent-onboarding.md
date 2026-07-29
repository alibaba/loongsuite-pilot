# Agent Onboarding

English | [简体中文](zh-CN/agent-onboarding.md)

Use this guide when you want LoongSuite Pilot to collect telemetry from a new AI coding agent. The goal is to make the new integration look like every other supported agent to users: auto-detectable, configurable, and exported through the same event schema and output backends.

## Integration Choices

Choose the lightest integration that the target agent supports.

| Integration | Use When |
|-------------|----------|
| Hook | The agent can run a command on lifecycle, prompt, response, or tool events. |
| Plugin injection | The agent can load a local plugin from its config file. |
| Local log or session polling | The agent already writes structured local files. |
| SQLite polling | The agent stores activity in a local SQLite database. |
| CLI or API polling | The agent exposes a local command or API for activity data. |

Prefer hooks or plugins when they can emit structured event records. They are easier to normalize and usually provide better coverage for tool calls and token usage.

## Required Pieces

Every new agent integration should provide:

1. An agent definition in `agents.d/<agent-id>.json`.
2. A hook, plugin, or polling source that produces activity records.
3. An input implementation that converts source records into `AgentActivityEntry`.
4. A `ClientType` value for the new agent.
5. Registration in the collector startup path when the input is not generic.
6. Tests or fixtures that prove the normalized output matches [Output Event Schema](output-event-schema.md).

## Agent Definition

Agent definitions describe how Pilot detects and deploys an integration. Built-in definitions are loaded from `agents.d/*.json`; local runtime definitions can override them from `~/.loongsuite-pilot/agents.d.local/`.

Hook-based example:

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.my-agent"],
    "commands": ["my-agent"]
  },
  "hook": {
    "settingsPath": "~/.my-agent/settings.json",
    "events": ["Stop", "PreToolUse", "PostToolUse"],
    "hookCommand": "$PILOT_DATA/hooks/my-agent-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

Plugin-injection example:

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "plugin-inject",
  "detection": {
    "paths": ["~/.config/my-agent"],
    "commands": ["my-agent"]
  },
  "pluginInject": {
    "configPaths": [
      "~/.config/my-agent/config.json"
    ],
    "pluginSpec": "file://$PILOT_DATA/plugins/my-agent/plugin.mjs",
    "pluginId": "loongsuite-pilot-my-agent"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

Important fields:

| Field | Purpose |
|-------|---------|
| `id` | Stable agent ID used in config, output, and admission control. |
| `displayName` | Human-readable agent name. |
| `deployMode` | `hook`, `plugin-inject`, or `plugin-probe`. |
| `detection.paths` | Local paths that indicate the agent is installed. |
| `detection.commands` | Commands that indicate the agent is installed. |
| `hook` | Hook settings path, events, command, and format. Required for hook mode. |
| `pluginInject` | Config paths and plugin spec. Required for plugin injection mode. |
| `input` | Source type and source location for the collector input. |

`pluginInject.configKey` can target an array field other than the default
`plugin` / `plugins` fields (for example Pi Coding Agent uses `extensions`). Set
`pluginInject.createIfMissing` to create the first configured JSON file when
the agent supports an empty settings file.

> When adding a `plugin-inject` agent, also register it in the uninstaller (`deploy/installer-opensource.sh` / `.ps1`) so its injected spec is removed on uninstall. Plugin-inject agents are additionally self-healed at runtime by the hook watchdog, which re-injects the spec if another tool overwrites the config.

## Emit Normalized Records Early

For single-writer hook and plugin integrations, the hook or plugin may write
newline-delimited JSON records to:

```text
~/.loongsuite-pilot/logs/<agent-id>/<agent-id>-YYYY-MM-DD.jsonl
```

Do not let multiple agent processes append directly to the same JSONL file.
Cross-process append behavior is not a sufficient record-framing guarantee. Use
the per-event spool described in [Reliable Hybrid Collection](#reliable-hybrid-collection),
or a writer whose inter-process safety has been explicitly proven.

Use canonical dotted fields whenever possible:

```json
{
  "time_unix_nano": "1778586618041000000",
  "observed_time_unix_nano": "1778586618041000000",
  "event.id": "event-uuid",
  "event.name": "tool.result",
  "user.id": "user-id",
  "gen_ai.session.id": "session-id",
  "gen_ai.agent.type": "my-agent",
  "gen_ai.provider.name": "openai",
  "gen_ai.tool.name": "bash",
  "gen_ai.tool.call.id": "call-id",
  "gen_ai.tool.call.duration": 423
}
```

Keep source-specific fields under `agent.<agent-id>.*` so public output fields stay stable.
These fields may be used by normalization and enrichment, but SLS and local JSONL outputs drop them by default.

## Implement The Input

Use an existing input style that matches the source:

| Source | Recommended Input Style |
|--------|-------------------------|
| Hook or plugin JSONL | Extend `BaseHookInput`, or reuse `transformHookRecord` when the source already emits canonical dotted fields. |
| Local session files | Extend `BaseSessionInput`. |
| SQLite database | Extend `BaseSqliteInput`. |
| IDE history snapshots | Extend `BaseIdeInput`. |
| CLI telemetry files | Extend `BaseCliForwarder`. |
| Local CLI/API | Extend `BaseInput` directly. |

The input should:

- Incrementally read only new records.
- Preserve checkpoints across restarts.
- Emit `AgentActivityEntry` objects.
- Avoid exporting raw sensitive content unless policy allows it.
- Attach stable session, turn, tool call, and error identifiers when available.

## Reliable Hybrid Collection

An integration that combines a transcript or database with lifecycle hooks has
two different kinds of evidence:

- The transcript is the primary semantic source for messages, model output,
  native identifiers, token usage, and source timestamps.
- A hook is an observation of a lifecycle boundary. It can wake the collector,
  seal a stable transcript range, and repair missing structural data, but it
  must not overwrite stronger transcript evidence.

Keep that precedence explicit in code and tests. A Hook timestamp may fill a
missing transcript timestamp only when the Hook represents the same semantic
boundary and can be matched unambiguously. The same rule applies to tool name
and call ID. Do not infer model finish reason from a generic agent status such
as `completed`; use a model-native reason when the source provides one, or a
proven lifecycle boundary such as a stable `Stop` event.

### LLM and tool time boundaries

`time_unix_nano` is the time of the semantic event. It is not the time at which
Pilot read the file; that belongs in `observed_time_unix_nano`.

For an LLM span:

- Start it at the corresponding `llm.request` boundary: the prompt submission
  for the first step, or the point at which the next model input becomes
  available after a tool result for a later step.
- End it at the paired `llm.response` boundary: the earliest native timestamp
  that proves model output for that step, including reasoning, text, or
  tool-call intent.
- Prefer a transcript response timestamp over an earlier or later `Stop` Hook
  observation. Use the Hook only as a documented fallback when the transcript
  has no response time.
- Pair request and response by stable session/turn/step identity. Never pair
  unrelated adjacent records merely because their order looks plausible.

For a TOOL span:

- Use the matched `tool.call`/`PreToolUse` time as the start and the matching
  `tool.result`/`PostToolUse` time as the end.
- Correlate by a stable tool-call ID. A positional fallback is unsafe when
  calls are parallel. Hook identity may repair a missing transcript identity
  only when exactly one match is possible.
- Set `gen_ai.tool.call.duration` to `result time - call time` in milliseconds
  only when both boundaries exist and the result is positive. Otherwise omit
  the duration.
- If the required tool name, call identity, or event timestamp cannot be
  established, omit the affected tool event instead of emitting `unknown`,
  zero, or a guessed value.

Acceptance tests must convert normalized events into spans and assert the exact
LLM and TOOL start/end times, not just the presence of events or attributes.
Use realistic Unix epoch timestamps in converter tests; very early synthetic
epochs can trigger timestamp clamping in telemetry libraries and hide the
actual pairing behavior.

### Checkpoints under transient failures

Treat “the source was not observed” and “the source was deleted” as different
states:

- Start every collection cycle from a copy of the last committed offsets and
  file metadata. A directory scan, `stat`, or read error preserves that state.
- Return an explicit scan-completeness signal. An empty result from an
  incomplete scan is not evidence of deletion.
- Remove per-file checkpoints only after a complete inventory and a definite
  not-found result. Permission errors, temporary unmounts, rename windows, and
  other I/O failures must retain the checkpoint.
- Detect replacement or truncation using file identity and size before
  resetting an offset. Never advance past an incomplete JSONL record.
- When the producer writes a turn in several chunks, wait for a stable semantic
  boundary (for example, observe the same file snapshot after `Stop`) before
  parsing and advancing the offset.
- On first discovery, deliberately choose and test whether existing history is
  baselined or replayed. Do not let that choice emerge accidentally from a
  default offset.

Pilot's common input lifecycle considers a batch accepted once `BaseInput` has
emitted it to the `InputManager` queue, then persists the input state without
waiting for a flusher acknowledgement. Do not add a private pending-batch
protocol or local outbox to one integration unless the whole delivery contract
requires it. The normal trade-off permits a small duplicate or loss window
around process crashes while keeping checkpoint behavior consistent across
inputs.

Required recovery tests should cover a restart, a partial final record, a
temporarily unavailable directory that later returns, file truncation or
replacement, and confirmed deletion. The unavailable-directory test must prove
that both the old checkpoint and any unconsumed Hook evidence survive.

### Multi-process Hook event spool

When hooks may run concurrently in multiple agent processes, store structural
Hook evidence as an ephemeral per-session spool:

1. Require a stable session ID and transcript path. Derive a filesystem-safe
   session directory name from sanitized text plus a hash; never trust the raw
   ID as a path.
2. Write one immutable file per event. Use a unique name containing enough
   entropy to avoid collisions across processes.
3. Create a same-directory temporary file with exclusive creation, write one
   complete JSON object, and atomically rename it to its published extension.
   The collector reads only published files, so it can never observe a
   half-written record.
4. Keep the hook fail-open: logging failures must not change or block the
   agent's behavior. Restrict directory and file permissions where supported.
5. Scope matching by canonical transcript path and session ID. Treat Hook data
   as a supplement to the transcript, and consume only uniquely matched
   structural evidence.
6. Delete published events after their transcript range has been checkpointed.
   Remove the session spool when deletion of the corresponding transcript is
   confirmed by a complete scan. Clean abandoned temporary files only after a
   grace period so a live writer is not raced.

This spool has the transcript's lifecycle; it is not a permanent audit log and
does not need size-based rotation. Its boundedness comes from consuming
checkpointed events and deleting sessions whose transcripts are gone.

For a working reference, see
`assets/hooks/workbuddy-hook-event-writer.mjs`,
`src/inputs/workbuddy/workbuddy-input.ts`, and their tests in
`tests/unit/hooks/workbuddy-hook-event-writer.test.ts` and
`tests/unit/inputs/workbuddy-input.test.ts`.

## Register The Agent

When a custom input class is needed:

1. Add the agent to `src/types/client-type.ts`.
2. Import and register the input in `src/core/orchestrator.ts`.
3. Map listener IDs to the public agent ID so `agent-control.json` and `config.agents` work.
4. Add default listener configuration when the input needs polling.
5. Add the built-in agent definition to `agents.d/`.

If your integration follows an existing hook or plugin record shape, keep the code change smaller by reusing the existing base input and `transformHookRecord`. The input still needs to be registered in the collector startup path.

## Quality Acceptance Gates

An integration is ready only after all applicable gates below pass.

### Field quality

- Fields marked Required in the [Output Event Schema](output-event-schema.md) must have 100% coverage. Conditionally Required fields must have 100% coverage whenever their condition applies.
- Report Recommended-field coverage separately for each `event.name`. When the source does not expose a field, record that evidence instead of inventing `unknown`, zero tokens, zero duration, or another plausible-looking default.
- Preserve native JSON types in JSONL: numbers and booleans remain scalars, while messages, tool arguments, and tool results remain arrays or objects as defined by the schema.
- Validate Unix-nanosecond timestamps, trace/span identifiers, non-negative token values, and positive tool duration in milliseconds. Omit duration when the source cannot establish a positive elapsed time.

### Event topology and recovery

- Every model step has a paired `llm.request` and `llm.response`.
- Match each `tool.call` and `tool.result` by `gen_ai.tool.call.id`; parallel tool calls must not collide.
- Keep session, turn, and step identifiers consistent, with at most one `gen_ai.turn.start` and one `gen_ai.turn.end` per turn when those markers are emitted.
- Event IDs are unique within a run and deterministic when the same source record is replayed.
- Checkpoints survive restart, emit only appended data, tolerate partial records, and do not replay unbounded history.

### Privacy and fixtures

- Support `captureMessageContent: false` for prompts, completions, reasoning, tool arguments, and tool results when the agent exposes those fields.
- Keep secrets out of source-specific extension fields unless they are required and subject to masking.
- Verify `mask.mode: all` masks API keys, access keys, private keys, and database URLs. See [Data Masking](masking.md).
- Hook and plugin code must fail open so telemetry cannot block the source agent.
- Commit only synthetic fixtures. They must not contain real prompts, transcripts, user names, home paths, repository paths, session IDs, or credentials.
- Prefer the smallest set of tests that covers distinct semantic branches; do not add duplicate tests solely to increase test count.

### Required scenarios

Cover detection/deployment, hook or plugin record generation, checkpointing, content capture disabled, and masking. Exercise at least:

- a text-only turn;
- one tool call;
- parallel tool calls and their results;
- an explicit failure or cancellation;
- restart/replay and incremental append.

### Final installed-product acceptance

- Run typecheck, the full unit/integration suite, build, and package installation.
- Record the target JSONL line count before the probe and analyze only rows appended by the new interaction.
- Exercise the real agent: use its CLI for CLI agents and Computer Use for GUI agents.
- Report event counts, per-event field coverage, correlation checks, native-type checks, privacy checks, and any evidence-backed gaps.
- Run the JSONL validator with `E2E_JSONL_STRICT=1` and explicitly select the
  agent under test with `E2E_JSONL_AGENT_FILTER=<agent-id>` when it is outside
  the default headless L1 set. For example, WorkBuddy GUI acceptance must use
  `E2E_JSONL_AGENT_FILTER=workbuddy`. Strict mode is the single automated
  quality gate; do not add agent-specific bypass modes.

## User Documentation Checklist

When adding a public agent, update:

- Supported agent tables in [README](../README.md) and [Product Overview](overview.md).
- Configuration examples if the agent needs special setup.
- [Data Masking](masking.md) if the agent emits new sensitive content fields.
- [Output Event Schema](output-event-schema.md) only when adding stable public fields.
