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
