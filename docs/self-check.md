# Self-Check & Notifications

Self-check periodically detects when an agent is actively being used but Pilot has stopped (or never started) collecting its data — a common symptom of an agent upgrade that silently breaks Pilot's hook or plugin. When this happens, Pilot sends an alert to a DingTalk group robot so developers are notified quickly.

Self-check is **disabled by default** and must be explicitly enabled.

## How It Works

Every `intervalMs` (default 10 minutes), for each enabled agent that has an `activityIndicator`, Pilot checks two things:

1. **Is the agent being used?** — The `activityIndicator` file's modification time is within `dataGapThresholdMs`.
2. **Is Pilot collecting data?** — The agent's input has produced events recently.

It then raises one of two alerts:

| Alert | Condition | Meaning |
|-------|-----------|---------|
| `DATA_GAP` | Pilot collected data before, but has been idle beyond `dataGapThresholdMs` while the agent is active | Collection likely broke (e.g. after an agent upgrade) |
| `NEVER_COLLECTED` | Pilot has never collected any data, the agent is active, and Pilot has been running longer than `neverCollectedGraceMs` | Hook/plugin was never functional |

Each alert is suppressed for `cooldownMs` (default 24h) per agent per alert type to avoid repeated notifications.

Hook installation integrity is already handled by the separate hook watchdog; self-check focuses only on the data-collection gap.

## Enable Self-Check

Add to `~/.loongsuite-pilot/config.json`:

```json
{
  "selfCheck": {
    "enabled": true,
    "intervalMs": 600000,
    "dataGapThresholdMs": 14400000,
    "neverCollectedGraceMs": 14400000,
    "cooldownMs": 86400000
  },
  "notifications": {
    "dingtalk": {
      "enabled": true,
      "webhookUrl": "https://oapi.dingtalk.com/robot/send?access_token=YOUR_TOKEN",
      "secret": "YOUR_SIGN_SECRET"
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `selfCheck.enabled` | `false` | Enables self-check. |
| `selfCheck.intervalMs` | `600000` (10 min) | How often the check runs. |
| `selfCheck.dataGapThresholdMs` | `14400000` (4h) | Idle time before a `DATA_GAP` alert; also the activity window. |
| `selfCheck.neverCollectedGraceMs` | `14400000` (4h) | Grace period after startup before a `NEVER_COLLECTED` alert. |
| `selfCheck.cooldownMs` | `86400000` (24h) | Suppression window per agent per alert type. |
| `notifications.dingtalk.enabled` | auto | Enables DingTalk. Auto-enabled when both `webhookUrl` and `secret` are set; set explicitly to `true` for keyword-filter bots without a secret. |
| `notifications.dingtalk.webhookUrl` | `""` | DingTalk custom robot webhook (includes `access_token`). |
| `notifications.dingtalk.secret` | `""` | HMAC-SHA256 signing secret. Leave empty for keyword-filter bots. |

Environment variables (override config file):

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_SELFCHECK_ENABLED` | Enables self-check. |
| `LOONGSUITE_PILOT_SELFCHECK_INTERVAL_MS` | Check interval. |
| `LOONGSUITE_PILOT_SELFCHECK_DATA_GAP_THRESHOLD_MS` | Data-gap threshold. |
| `LOONGSUITE_PILOT_SELFCHECK_NEVER_COLLECTED_GRACE_MS` | Never-collected grace period. |
| `LOONGSUITE_PILOT_SELFCHECK_COOLDOWN_MS` | Alert cooldown. |
| `LOONGSUITE_PILOT_DINGTALK_ENABLED` | Enables DingTalk. |
| `LOONGSUITE_PILOT_DINGTALK_WEBHOOK_URL` | Webhook URL. |
| `LOONGSUITE_PILOT_DINGTALK_SECRET` | Signing secret. |

## DingTalk Robot Setup

Create a custom robot in your DingTalk group (Group Settings → Robots → Add → Custom). Choose one security mode:

- **Signing (recommended)**: copy the secret into `notifications.dingtalk.secret`.
- **Keyword filter**: add the keyword `loongsuite-pilot`. Alert titles begin with `loongsuite-pilot self-check:` so they pass the filter. Leave `secret` empty and set `enabled: true`.

Notifications never affect the main collection pipeline: any send failure is logged and swallowed. The gateway also rate-limits to at most one message every 3 seconds (well under DingTalk's 20/min cap).

## Alert Content

Each alert includes the agent id and display name, **agent version**, **Pilot version**, host, user, timestamp, and a description. Versions help pinpoint whether an agent upgrade caused the break.

## Per-Agent Configuration

Self-check reads two optional fields from each agent definition in `agents.d/*.json`. Agents without an `activityIndicator` are skipped.

### `activityIndicator`

Path to a native file whose modification time signals the agent is in use. `~` is expanded.

```json
"activityIndicator": "~/.claude/history.jsonl"
```

### `versionSource`

How to resolve the agent's version. Supported types:

```json
"versionSource": { "type": "jsonFile", "file": "~/.codex/version.json", "key": "latest_version" }
"versionSource": { "type": "jsonlTail", "file": "~/.cursor/audit/audit.jsonl", "key": "cursor_version" }
"versionSource": { "type": "newestJsonFile", "dir": "~/.claude/sessions", "key": "version" }
"versionSource": { "type": "newestSubdirFile", "dir": "~/.qoder/logs/runs", "file": "manifest.json", "key": "cli_version" }
"versionSource": { "type": "command", "command": "opencode --version" }
```

| Type | Behavior |
|------|----------|
| `jsonFile` | Read `key` from a JSON file. |
| `jsonlTail` | Read `key` from the last valid line of a JSONL file. |
| `newestJsonFile` | Read `key` from the newest (last-sorted) `.json` file in `dir`. |
| `newestSubdirFile` | Read `key` from `file` inside the newest subdirectory of `dir`. |
| `command` | Run `command` and use the first line of stdout. |

If resolution fails, the version is reported as `unknown` and the alert is still sent.

### Built-in Agent Signals

| Agent | activityIndicator | version source |
|-------|-------------------|----------------|
| Claude Code | `~/.claude/history.jsonl` | newest session json → `version` |
| Codex | `~/.codex/session_index.jsonl` | `~/.codex/version.json` → `latest_version` |
| Cursor | `~/.cursor/audit/audit.jsonl` | audit tail → `cursor_version` |
| Qoder | `~/.qoder/audit/audit.jsonl` | newest run `manifest.json` → `cli_version` |
| QoderWork | `~/.qoderwork/audit/audit.jsonl` | `~/.qoderwork/.status.json` → `version` |
| OpenCode | `~/.local/share/opencode/opencode.db-wal` | `opencode --version` |
| Qwen Code CLI | `~/.qwen/debug/latest` | `qwen --version` |
