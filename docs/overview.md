# Product Overview

English | [简体中文](zh-CN/overview.md)

LoongSuite Pilot runs on a developer machine and collects telemetry from supported AI coding agents. It is designed for teams that need a consistent view of agent usage, model calls, tool activity, token consumption, and operational health without asking each agent to report in a different format.

## Core Capabilities

| Capability | What It Means |
|------------|---------------|
| Agent discovery | Detect installed supported agents from local paths and commands. |
| Collection deployment | Install hooks or plugins for supported agents, and watch local logs or session files when needed. |
| Activity normalization | Convert each agent's native events into one GenAI event schema. |
| Log reporting | Export normalized events to JSONL, SLS, or HTTP. |
| Trace reporting | Export GenAI conversations and tool activity as OTLP traces. |
| Token usage | Capture input, output, cache read, and cache creation tokens when the source agent exposes them. |
| Tool activity | Capture tool call names, arguments, results, durations, and errors when available. |
| Privacy controls | Disable message content capture per agent and mask secrets before output. |
| Runtime operations | Manage the background service, inspect status, run an optional dashboard, and rollback versions. |

## Supported Agents

| Agent | Integration | Trace Export | Log Export | Token Usage | Conversation / Tool Calls |
|-------|-------------|--------------|------------|-------------|---------------------------|
| Claude Code | Hook | Yes | Yes | Yes | Yes |
| Codex | Hook | Yes | Yes | Yes | Yes |
| Cursor | Hook | Yes | Yes | Yes | Yes |
| OpenCode | Plugin injection | Yes | Yes | Yes | Yes |
| Qoder | Hook | Yes | Yes | Yes | Yes |
| Qoder CN | Hook | Yes | Yes | Yes | Yes |
| Qoder CLI | Hook / session polling | Yes | Yes | No | Yes |
| Qoder Work | Hook / local data polling | Yes | Yes | No | Yes |
| Qoder Work CN | Hook / local data polling | Yes | Yes | No | Yes |

## Data Collected

Pilot focuses on activity that is useful for usage analysis, audit, and traceability:

- LLM requests and responses.
- User sessions, turns, and intermediate agent steps.
- Tool calls, tool results, tool duration, and tool errors.
- Token usage and cost-related fields when available.
- Model provider and model name.
- Git repository, branch, and current workspace root.
- Host and service metadata.
- Agent-specific extension fields when a source exposes additional context.

Message content, tool arguments, and tool results can contain sensitive information. These fields are documented as opt-in in the [Output Event Schema](output-event-schema.md), can be disabled per agent, and can be masked before export.

## Output Destinations

Pilot can fan out the same normalized event stream to multiple destinations:

| Destination | Typical Use |
|-------------|-------------|
| JSONL | Local backup, debugging, and simple offline inspection. |
| SLS | Centralized log analytics in Alibaba Cloud Log Service. |
| HTTP | Custom ingestion service or gateway. |
| OTLP Trace | Trace backend, APM, or GenAI observability platform. |

If no remote backend is configured, JSONL remains enabled by default so collected data is still visible locally.

## Local Runtime

Default local data directory:

```text
~/.loongsuite-pilot/
```

Important files and directories:

| Path | Purpose |
|------|---------|
| `config.json` | Main user configuration. |
| `agent-control.json` | Per-agent admission control: `on`, `off`, or `auto`. |
| `deployed-agents.json` | Records deployed hooks and plugins. |
| `hooks/` | Installed hook scripts. |
| `plugins/` | Installed plugin assets. |
| `logs/output/` | Local normalized JSONL output. |
| `logs/input-state.json` | Input offsets and checkpoints. |
| `sls-failed-logs/` | SLS upload failures persisted for diagnosis. |
| `versions/` and `current` | Versioned runtime layout used for updates and rollback. |

## Where To Go Next

- Install Pilot with [Installation](installation.md).
- Configure outputs and agent selection in [Configuration Guide](configuration.md).
- Choose agents and content capture policy in [Agent Configuration](agents.md).
- Configure local output in [Local JSONL Output](local-jsonl-output.md).
- Configure SLS reporting in [SLS Output](sls-output.md).
- Configure trace reporting in [Trace Output](trace-output.md).
- Configure custom HTTP reporting in [HTTP Output](http-output.md).
- Configure secret masking in [Data Masking](masking.md).
- Review emitted fields in [Output Event Schema](output-event-schema.md).
- Add a new agent integration with [Agent Onboarding](agent-onboarding.md).
