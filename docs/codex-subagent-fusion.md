# Codex subagent work contexts and historical fusion

> The fusion state machine below describes the historical implementation before independent child turns.
> The target design is [子 Agent 数据模型与采集设计](zh-CN/subagent-data-model.md):
> preserve child session/turn identity, attach through trace context, and correlate
> audit work through invocation IDs. The source now uses independent child turns;
> see [implementation and verification](zh-CN/codex-subagent-verification.md) for reproducible checks and evidence boundaries.

## Current source behavior

Each native Codex thread keeps its own session, turn and step IDs. A recoverable
delegation descriptor records the immediate parent, native tool call, actual
reserved tool span, trace, invocation and child-work evidence. Child turns
convert and export independently under that tool; parent completion never seals
an unfinished child or stretches the parent tool interval. A missing or
ambiguous attachment keeps an independent root, and already-emitted trace
identity is never rewritten by a later link.

Parent `gen_ai.agent.invoke`/`gen_ai.agent.result` logs and child
`gen_ai.agent.parent.invocation.id` describe work, including new work in reused
sessions. Tool acceptance is not an Agent result. The legacy four short event
names remain supported alongside the six standard names without duplicate
spans or usage. Codex uses a dedicated conversion boundary; other Agents retain
their existing adapters.

The input checkpoint retains native turn emission state and delegation binding;
global input state retains bounded delegation/result identity. Old
`pendingFusion`/`pendingSubagent` checkpoints are read for independent recovery,
not to restart a parent barrier. Historical data is not automatically repaired.
With OTLP enabled, a pending-turn journal retains the full canonical prefix
before source checkpoints advance. Unfinished turns survive exit and eviction;
completed turns record export acknowledgements before pending data is removed.
The latest 10,000 acknowledgements suppress source replay; network delivery
remains at least once. Codex SLS/HTTP log delivery also waits for network success
before input checkpoint advancement; a failure holds the shared checkpoint until
the output is repaired and the collector restarts. See the implementation guide
for storage and output failure recovery.

## Historical implementation (before independent child turns)

All present-tense statements below describe the old fusion path, not the current
source or its runtime acceptance status.

Codex depth-one subagent rollouts are formally fused into the parent trace.
The linker still exposes lower-confidence matches for diagnostics, but those
matches do not all have authority to change trace ownership.

## Reliable identity and confidence

Each `spawn_agent` lifecycle is uniquely identified by the parent
`parentToolCallId`. An `agent_path` is descriptive metadata and may be reused
by multiple spawn calls, so it is never used as a deduplication key.

Only these confidence levels can execute fusion:

- `explicit_id`: the child thread id occurs on exactly one parent spawn.
- `agent_path`: the child path matches exactly one still-available parent
  spawn. Repeated matching paths are ambiguous and cannot execute fusion.

`time_order` is diagnostic-only. It can explain a likely relationship in the
link snapshot and logs, but it cannot create a fusion candidate, capture a
child terminal, or delay a parent terminal. `orphan` is also never fused.

## Fusion state machine

1. `activeTurn`: incremental parent and child records continue to emit
   normally. A parent turn also retains observed `spawn_agent` descriptors,
   keyed by `parentToolCallId`.
2. `pendingSubagent`: when a child terminal has a reliable candidate, its scan
   offset advances past the terminal. The completed active-turn snapshot and
   exact parent spawn identity are persisted here. This means the terminal is
   consumed but has not been emitted as an independent trace. Later turns in
   the same child rollout can continue to be scanned.
3. `pendingFusion`: the parent `task_complete` is the direct-child lifecycle
   barrier. Its terminal range and reliable candidates are persisted as a
   crash-safe staging state while the current collection cycle finishes
   processing child files.
4. `ready/finalize`: a captured child is rebuilt from `pendingSubagent`. A
   reliably linked child that has an un-emitted `activeTurn` but no terminal is
   force-closed at its consumed file offset and marked interrupted. Missing or
   unsafe-to-rebuild children are degraded instead of delaying the parent.
   Rebuilt children are rewritten with parent trace attributes and emitted
   before the parent terminal; the parent is always released in that finalize
   pass.

There is no wall-clock fusion timeout because `pendingFusion` is not a
long-running wait state. Parent `task_complete` causes same-cycle finalize or
independent degradation.

## Independent-trace degradation

Fusion is deliberately conservative:

- A child terminal without a reliable candidate is emitted immediately as an
  independent trace.
- If a captured `agent_path` candidate later becomes ambiguous or its exact
  spawn identity no longer matches, the saved child snapshot is rebuilt and
  emitted once as an independent trace.
- If a pending parent loses all reliable candidates, its terminal is rebuilt
  and emitted independently and its offset advances.
- If a reliable child has no terminal when the parent completes, its complete
  un-emitted active turn is rebuilt as interrupted. If that is not possible,
  the parent still completes and the child is left to the independent path.
- `followup_task` does not create a new child lifecycle.
- Aborted child turns use their terminal marker and follow the same ownership
  and degradation rules.

## Checkpoint fields and compatibility

`CodexTranscriptCheckpoint` persists:

- `scanOffset`: the next unread rollout byte. It advances past a captured child
  terminal even while that terminal is awaiting fusion.
- `activeTurn`: the currently streaming turn and its incremental emission
  state. Parent turns also retain spawn descriptors keyed by
  `parentToolCallId`.
- `pendingSubagent`: a consumed, not-independently-emitted child terminal. It
  stores `turnId`, `parentThreadId`, `parentTurnId`, `parentTraceId`,
  `parentToolCallId`, reliable `confidence`, `terminalEndOffset`, and the full
  active-turn snapshot needed for restart recovery.
- `pendingFusion`: a held parent terminal containing its parent identity,
  terminal range, and reliable child candidates.
- `pendingTerminal`: a terminal range that was persisted but could not yet be
  parsed; it is retried before later transcript data.
- `emittedTerminalTurnIds`: bounded per-rollout protection against duplicate
  terminal emission. A bounded global registry provides cross-rollout
  protection.
- `ownerSessionMetaOffset`: identifies the rollout's own `session_meta` rather
  than copied parent history.

Legacy `pendingSubagent` checkpoints kept the active child turn at the top
level and did not store a reliable spawn identity. They cannot be safely
fused, so checkpoint loading migrates them into the normal independent
`pendingTerminal` recovery path. Legacy metadata checkpoints without
`ownerSessionMetaOffset` use a bounded header scan to recover the owning
session metadata.
