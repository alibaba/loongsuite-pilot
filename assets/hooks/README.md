# Asset Hooks Design Guide

`assets/hooks/` contains the hook entrypoints and processors installed to
`~/.loongsuite-pilot/hooks/` by `scripts/postinstall.js`.

These files run inside, or immediately after, an AI coding agent's hook
execution path. Keep them small, deterministic, and fail-open.

## Runtime Shape

```
Agent hook event
    ↓ stdin JSON / transcript path
*-loongsuite-pilot-hook.sh
    ↓ resolves Node and delegates
*processor.mjs
    ↓ shared agent-event-normalizer.mjs + append-only JSONL
~/.loongsuite-pilot/logs/<agent>/history/<agent>-YYYY-MM-DD.jsonl
    ↓ tailed by
src/inputs/<agent>/*-input.ts
```

Shell entrypoints own runtime discovery and fail-open behavior. Processor files
own parsing, source-specific extraction, deterministic per-event normalization,
and writing history/error/debug files. Shared mapping behavior belongs in
`agent-event-normalizer.mjs`; source processors should only keep source-specific
extraction logic.

## Output Contract

Each history JSONL line must be a JSON object.

For new processors, prefer a standard-compatible hook record:

```json
{
  "time_unix_nano": "1778586618041000000",
  "observed_time_unix_nano": "1778586618041000000",
  "event.id": "uuid-or-source-event-id",
  "event.name": "tool.result",
  "gen_ai.session.id": "session-id",
  "gen_ai.agent.type": "cursor",
  "gen_ai.tool.name": "edit_file",
  "gen_ai.tool.call.id": "tool-call-id",
  "agent.cursor.hook_event_name": "postToolUse"
}
```

Use canonical dotted keys for stable fields. Put source-specific raw context in
an `agent.<source>.*` namespace. Do not duplicate source keys at the top level
when they have been mapped into canonical fields.

## Normalization Boundary

It is acceptable to migrate source-specific field normalization from
`BaseHookInput` subclasses into asset processors when the source payload is only
available at hook time or is cheaper to interpret there.

Keep these boundaries:

- Processors may extract stable fields such as `event.name`, `gen_ai.session.id`,
  model, token, tool, and error fields.
- Processors may add event IDs, observed timestamps, hashes, and source metadata.
- Processors may apply best-effort `user.id` defaulting, provider fallback, and
  content-policy filtering before writing history. Collector-side normalization
  still re-applies these as the authoritative final pass.
- Processors must not flush to SLS/HTTP/JSONL output targets directly.
- Processors must not mutate agent settings; `HookManager` owns installation.
- Inputs still own incremental tailing, checkpoints, final validation/building,
  and emitting entries into the collector pipeline.

## Sensitive Content

Tool arguments, tool results, prompts, responses, diffs, and file contents may
contain sensitive data. Prefer hashes, summaries, or redacted fields unless the
agent's content policy explicitly allows full capture.

If full content is preserved, keep it in the canonical `gen_ai.*` content fields
or clearly named `agent.<source>.*` fields so downstream policy can remove it.

## Failure Behavior

Hooks must never block the source agent:

- Missing Node, missing processor, invalid JSON, read errors, and append errors
  must exit successfully from the agent's perspective.
- Cursor hooks should print `{}` to stdout.
- Errors should be written to local `logs/<agent>/errors/` when possible.
- Debug logs and line-offset records are best-effort only.

## Migration Pattern

When moving normalization into a processor:

1. Emit standard-compatible records from the processor.
2. Put common mapping in `agent-event-normalizer.mjs` rather than duplicating it
   in every processor.
3. Keep old raw/transcript output compatibility while existing inputs need it.
4. Update the matching `BaseHookInput` subclass to prefer canonical dotted keys
   and use old parsing only as fallback.
5. Add tests for processor output and input fallback behavior.
6. Verify replay from history JSONL still produces the same `AgentActivityEntry`
   semantics.
