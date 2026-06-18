# Agent Configuration

English | [简体中文](zh-CN/agents.md)

Use this guide to choose which AI coding agents Pilot should collect from and whether sensitive message content should be captured.

## Supported Agent IDs

Use these IDs in installer options, `agent-control.json`, and `config.json`.

| Agent | ID | Notes |
|-------|----|-------|
| Claude Code | `claude-code` | Hook integration. |
| Codex | `codex` | Hook integration. |
| Cursor | `cursor` | Hook integration. |
| OpenCode | `opencode` | Plugin injection. |
| Qoder | `qoder` | Hook integration. |
| Qoder CN | `qoder-cn` | Hook integration. |
| Qoder CLI | `qoder` | Shares the Qoder agent definition and uses hook/session sources. |
| Qoder Work | `qoder-work` | Hook and local data sources. |
| Qoder Work CN | `qoder-work-cn` | Hook and local data sources. |

## Choose Agents During Installation

Use `--agents` to skip the interactive selection step:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor"
```

The installer still checks whether each selected agent exists on the machine before deploying collection capabilities.

## Enable Or Disable Agents After Installation

Use `~/.loongsuite-pilot/agent-control.json` for simple admission control:

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "qoder": "off"
  }
}
```

| Mode | Meaning |
|------|---------|
| `on` | Force-enable the agent when its data source exists. |
| `off` | Disable the agent. |
| `auto` | Use default auto-detection behavior. |

Restart Pilot after changing this file:

```bash
loongsuite-pilot restart
```

## Configure Content Capture Per Agent

Use `config.json` when you need to control message content capture:

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Set to `false` to disable the agent from config. |
| `captureMessageContent` | Set to `false` to avoid collecting full prompts, completions, tool arguments, and tool results where the integration supports that policy. |

For sensitive environments, pair `captureMessageContent: false` with [Data Masking](masking.md).

## Verify Agent Collection

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

If an expected agent is not collecting:

- Confirm the agent is installed and has been used at least once.
- Confirm the agent ID is not set to `off` in `agent-control.json`.
- Confirm `config.json` does not set the agent to `"enabled": false`.
- Restart Pilot after configuration changes.
