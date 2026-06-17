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

## Emit Normalized Records Early

For hook and plugin integrations, make the hook or plugin write newline-delimited JSON records to:

```text
~/.loongsuite-pilot/logs/<agent-id>/<agent-id>-YYYY-MM-DD.jsonl
```

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

## Register The Agent

When a custom input class is needed:

1. Add the agent to `src/types/client-type.ts`.
2. Import and register the input in `src/core/orchestrator.ts`.
3. Map listener IDs to the public agent ID so `agent-control.json` and `config.agents` work.
4. Add default listener configuration when the input needs polling.
5. Add the built-in agent definition to `agents.d/`.

If your integration follows an existing hook or plugin record shape, keep the code change smaller by reusing the existing base input and `transformHookRecord`. The input still needs to be registered in the collector startup path.

## Privacy Checklist

Before marking an integration ready:

- Support `captureMessageContent: false` for prompts, completions, tool arguments, and tool results when the agent exposes those fields.
- Keep secrets out of source-specific extension fields unless they are required and subject to masking.
- Verify `mask.mode: all` masks API keys, access keys, private keys, and database URLs in emitted output. See [Data Masking](masking.md).
- Fail open in hook/plugin code so the agent is never blocked by telemetry collection.

## Test Checklist

At minimum, add tests or fixtures for:

- Agent detection and deployment definition parsing.
- Hook or plugin record generation.
- Input checkpointing and incremental reads.
- Normalized `event.name` values.
- LLM request/response fields.
- Tool call/result correlation.
- Token fields when the source exposes usage.
- Content capture disabled mode.
- Masking enabled mode.

## User Documentation Checklist

When adding a public agent, update:

- Supported agent tables in [README](../README.md) and [Product Overview](overview.md).
- Configuration examples if the agent needs special setup.
- [Data Masking](masking.md) if the agent emits new sensitive content fields.
- [Output Event Schema](output-event-schema.md) only when adding stable public fields.
