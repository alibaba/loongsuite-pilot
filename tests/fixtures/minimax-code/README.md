# MiniMax Code CLI 0.7.9 source fixture

These records were produced by the official `@minimax-ai/code@0.7.9` macOS
CLI with Node 22 and an isolated data directory. The CLI ran two turns in the
same session against a loopback OpenAI-compatible fixture. One turn calls the
real local read tool against a synthetic workspace file.

All prompts, replies and tool data are synthetic. The temporary workspace and
compatibility transcript paths were replaced. Internal custom message details
and manifest paths unrelated to parsing were omitted. The native schema,
timestamp fields and correlation IDs remain intact.

The official hook `transcript_path` is a disposable compatibility snapshot.
The durable source is the session's `manifest.json` and `messages.jsonl`.
`turns.json` is a projection of the CLI's native SQLite turn ingress receipt.

`continuation/` captures a genuine turn in the same release with a separate
Stop hook that asks the runtime to continue once. The native records retain both
assistant steps and the follow-up user message. Both Stop observations share the
same turn ID and precede its native completion receipt.
