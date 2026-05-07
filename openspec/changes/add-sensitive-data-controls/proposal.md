## Why

Agent inputs can collect sensitive prompt, response, and tool-call content such as `input.messages`, `output.messages`, `tool.arguments`, and `tool.result.payload`. Users need a local `config.json` policy to decide, per agent type, whether those sensitive content fields are uploaded to downstream outputs such as SLS, JSONL, or HTTP.

## What Changes

- Add a user-configurable `contentData` section in `~/.loongsuite-pilot/config.json`, keyed directly by `agent.type` values such as `cursor`, `qoder-cli`, and `qoder-work`.
- Support per-agent `uploadEnabled` as the first-stage sensitive content upload control.
- Default behavior remains backward compatible: sensitive content is uploaded unless the user explicitly configures otherwise.
- Apply the policy in the input collection layer after each input has mapped raw records into `AgentActivityEntry` fields and before entries are dispatched to any flusher.
- Ensure all inputs that emit the same `agent.type` share the same policy, regardless of collection method.
- Treat missing, malformed, or incomplete sensitive-data config as fail-open defaults.

## Capabilities

### New Capabilities

- `sensitive-data-controls`: User-configured per-agent sensitive content upload policy for collector input output.

### Modified Capabilities

- None.

## Impact

- Affected code areas:
  - `src/types/index.ts`: Add sensitive-data config types.
  - `src/core/config-loader.ts`: Parse `contentData` from `config.json` with defaults.
  - `src/core/input-manager.ts`: Apply per-agent sensitive-data policy before dispatching entries.
  - New helper module for classifying sensitive fields and applying upload behavior.
- All flushers (`jsonl`, `sls`, `http`) receive entries after the same input-layer policy is applied.
- No new external dependencies are required.
