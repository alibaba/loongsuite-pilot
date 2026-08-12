# Codex subagent rollout fixtures

These compact JSONL fixtures preserve the structure observed in Codex Desktop
multi-agent v2 rollouts while replacing prompts, responses, thread IDs, names,
paths, and tool arguments with synthetic values.

The child rollout intentionally starts with its own `session_meta`, followed by
the copied parent `session_meta` and parent turn history. This ordering is the
regression case for selecting the rollout's owning metadata instead of the last
metadata record in the file.

The parent contains four `spawn_agent` calls whose returned task paths match
the four child `agent_path` values. Fusion tests use that mapping to prove
parallel children are associated one-to-one by `parentToolCallId` and emitted
under their parent trace.
