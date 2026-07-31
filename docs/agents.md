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
| Grok Build | `grok-build` | Four fail-open hooks plus local session-log fusion; captures LLM, token, tool, cancellation, and failure lifecycle data. |
| Kiro CLI | `kiro-cli` | Hook integration with delayed local SQLite/session collection. Token usage is not exposed by the source. |
| OpenCode | `opencode` | Plugin injection. |
| Pi Coding Agent | `pi-coding-agent` | Pi Extension injection; captures LLM and tool lifecycle events. |
| Qoder | `qoder` | Hook integration. |
| Qoder CN | `qoder-cn` | Hook integration. |
| Qoder for JetBrains | `qoder-jetbrains` | Detection-only deploy ID. Agent gating uses `qoder` in `agent-control.json`; content policy uses `qoder-idea` in `config.json`. |
| Qoder CLI | `qoder` | Shares the Qoder agent definition and uses hook/session sources. |
| Qoder Work | `qoder-work` | Hook and local data sources. |
| Qoder Work CN | `qoder-work-cn` | Hook and local data sources. |
| Qwen Code CLI | `qwen-code-cli` | Hook integration; parses qwen-code transcript JSONL on Stop. |
| Wukong | `wukong` | CLI API polling via local `wukong-cli`. |
| WorkBuddy | `workbuddy` | Structural Hook/file wakeups with a 30-second local transcript polling fallback. Verified on WorkBuddy Desktop 5.2.6 for macOS and 5.3.5.0 for Windows 11. |

The Windows verification used an installed Pilot package, resolved Node from the
installer-pinned `node-bin` with Node absent from `PATH`, and passed strict JSONL
validation against a real WorkBuddy transcript.

Codex collection is transcript-backed. Pilot uses the lightweight
`SessionStart` and `UserPromptSubmit` hooks to discover the effective
`CODEX_HOME`, including task-scoped homes created by orchestrators, and tails
recent rollout files from that session root. `Stop` is retained as a
best-effort wakeup and is not required for directory discovery.

### Grok Build collection

Pilot detects Grok Build when `~/.grok` exists and installs four fail-open
hooks in `~/.grok/hooks/loongsuite-pilot.json`: `stop`, `stop_failure`,
`user_prompt_submit`, and `session_end`. Subagent hooks are not supported;
Pilot removes obsolete Pilot-owned subagent and tool hooks during deployment.

Each completed turn is reconstructed from three Grok-owned JSONL sources:

- Session `chat_history.jsonl` for messages, model metadata, tool arguments,
  and the system instruction.
- Session `updates.jsonl` for prompt identity, turn completion, cancellation,
  failure, and tool status.
- `~/.grok/logs/unified.jsonl` for model timing, token usage, tool timing, and
  execution results.

Pilot starts from the turn observed after installation and does not replay
older session history. A cancellation can be collected on the next
`UserPromptSubmit` or `SessionEnd` because Grok persists its final cancellation
state asynchronously. Set `agents["grok-build"].captureMessageContent` to `false`
to remove user, assistant, and system content together with tool arguments,
tool results, and raw error details.

The distribution includes both POSIX and PowerShell hook launchers. The
general support table does not claim installed-product Windows verification;
Grok Build is intentionally omitted from the explicit Windows matrix until a
real Windows E2E run is recorded.

## Choose Agents During Installation

Use `--agents` to skip the interactive selection step:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor"
```

For Grok Build only:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "grok-build"
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
    "cursor": { "enabled": true, "captureMessageContent": true },
    "grok-build": { "enabled": true, "captureMessageContent": false }
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
