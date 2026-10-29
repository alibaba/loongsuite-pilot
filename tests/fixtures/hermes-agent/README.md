# Hermes Agent fixture provenance

`real-tool-turn-hooks.jsonl` is a sanitized subset of a real Hermes Agent
0.9.0 callback capture produced on 2026-07-10 at:

```text
<temporary-directory>/probe-events.jsonl
```

The original interaction made one `terminal` call for
`wc -l /etc/hosts /etc/shells`. Provider credentials and the provider endpoint
were not present in this fixture. Long prompt wording was shortened and all
correlation IDs were replaced with deterministic fixture values without
changing callback ordering, message roles, tool payloads, or usage fields.

`google-protocol.json` is entirely synthetic, including token counts, response
IDs and model output. Its native GenerateContent request/response and function
call shapes follow https://ai.google.dev/api/generate-content and
https://ai.google.dev/gemini-api/docs/function-calling; the Chat Completions
shapes follow https://ai.google.dev/gemini-api/docs/openai. Native streaming
uses these response objects as SSE `data:` frames; compatible streaming uses
Chat Completions delta frames. This fixture proves protocol compatibility,
not a successful call to Google's service. No API key is required.
