# Codex subagent trace fusion

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
