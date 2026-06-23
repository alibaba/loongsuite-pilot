# Codex Aborted Turn Recovery

## Goal

Export a complete Codex trace when a user interrupts an in-progress turn.
Recovery is transcript-backed: it emits only source data that Codex has
already persisted and ends the reconstructed turn with cancelled.

## Problem

Codex writes event_msg:turn_aborted into a rollout transcript when the user
interrupts generation. Pilot configures SessionStart, UserPromptSubmit,
PreToolUse, PostToolUse, and Stop, but this interruption does not dispatch
Pilot's terminal Stop Hook. The normal Hook processor therefore keeps prompt
and tool events in session state without writing an event log or OTLP trace.

## Architecture

CodexAbortedTurnInput tails ~/.codex/sessions/**/rollout-*.jsonl every
30 seconds. It maintains a checkpoint per transcript:

~~~
{
  inode: number;
  scanOffset: number;
  activeTurn: { turnId: string; startOffset: number; startedAtMs: number } | null;
  latestSessionMetaOffset: number | null;
  emittedAbortedTurnIds: string[]; // newest first, capped at 100
}
~~~

On task_started or turn_context, the input records the turn's byte offset.
When a complete matching turn_aborted arrives, it rereads exactly that range,
loads the most recent preceding session_meta, and rebuilds entries for the
user prompt, LLM steps, tool calls/results, agent messages, and token usage.

The extractor supports function_call, custom_tool_call, web_search_call, and
tool_search_call. Calls without a matching output before cancellation receive
tool.result.status = cancelled and intentionally omit a synthetic result or
duration.

## Bootstrap And Delivery Rules

- Existing transcript files are baselined on the first enablement; historical
  aborted turns are not replayed.
- A transcript created while Pilot is stopped is also baselined on restart.
  This intentional limitation preserves the no-history-backfill policy.
- The tailer advances only through complete newline-terminated JSONL records.
- A changed inode is baselined at its new end offset.
- Deterministic trace, span, and event IDs combine session ID, transcript turn
  ID, event kind, and index. The local emitted-ID ledger is bounded; stable IDs
  remain the downstream replay guard.
- BaseInput serializes polling cycles and waits for an active cycle during
  shutdown, preventing duplicate output and state-file rename races.

## Hook And OTLP Semantics

The normal Codex Hook parser reports abortedTurnIds, and the Stop exporter
skips those boundaries. This prevents duplicate traces if a future Codex
version emits both turn_aborted and Stop.

Recovered terminal responses include:

~~~
gen_ai.response.finish_reasons = ["cancelled"]
agent.codex.turn_status = "interrupted"
~~~

Cancellation is not a provider or agent error and must not set error.type.
The OTLP flusher treats cancelled as a terminal reason alongside stop and
end_turn. The installed GenAI converter preserves cancelled on the LLM and
ReAct-step spans. agent.codex.turn_status remains in the raw event log,
because the converter intentionally maps standard GenAI fields rather than
arbitrary agent.* fields.
