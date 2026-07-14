# Self-Check

Self-check periodically detects when an agent is actively being used but Pilot has stopped (or never started) collecting its data — a common symptom of an agent upgrade that silently breaks Pilot's hook or plugin. When this happens, Pilot records a **structured alarm event** so it can be surfaced through the standard metrics/alarm pipeline.

Self-check is **enabled by default**; set `selfCheck.enabled` to `false` to turn it off.

## How It Works

Every `intervalMs` (default 10 minutes), for each enabled agent that has an `activityIndicator`, Pilot checks two things:

1. **Is the agent being used?** — The `activityIndicator` file's modification time is within `dataGapThresholdMs`.
2. **Is Pilot collecting data?** — The agent's input has produced events recently.

It then raises one of two alerts:

| Alert | Condition | Meaning |
|-------|-----------|---------|
| `DATA_GAP` | Pilot collected data before, but has been idle beyond `dataGapThresholdMs` while the agent is active | Collection likely broke (e.g. after an agent upgrade) |
| `NEVER_COLLECTED` | Pilot has never collected any data, the agent is active, and Pilot has been running longer than `neverCollectedGraceMs` | Hook/plugin was never functional |

Each alert is suppressed for `cooldownMs` (default 24h) per agent per alert type to avoid repeated events.

Hook installation integrity is already handled by the separate hook watchdog; self-check focuses only on the data-collection gap.

## Configuration

Self-check runs with the defaults below. To tune it (or disable it), add to `~/.loongsuite-pilot/config.json`:

```json
{
  "selfCheck": {
    "enabled": true,
    "intervalMs": 600000,
    "dataGapThresholdMs": 14400000,
    "neverCollectedGraceMs": 14400000,
    "cooldownMs": 86400000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `selfCheck.enabled` | `true` | Enables self-check. Set to `false` to disable. |
| `selfCheck.intervalMs` | `600000` (10 min) | How often the check runs. |
| `selfCheck.dataGapThresholdMs` | `14400000` (4h) | Idle time before a `DATA_GAP` alert; also the activity window. |
| `selfCheck.neverCollectedGraceMs` | `14400000` (4h) | Grace period after startup before a `NEVER_COLLECTED` alert. |
| `selfCheck.cooldownMs` | `86400000` (24h) | Suppression window per agent per alert type. |

Environment variables (override config file):

| Variable | Description |
|----------|-------------|
| `LOONGSUITE_PILOT_SELFCHECK_ENABLED` | Enables self-check. |
| `LOONGSUITE_PILOT_SELFCHECK_INTERVAL_MS` | Check interval. |
| `LOONGSUITE_PILOT_SELFCHECK_DATA_GAP_THRESHOLD_MS` | Data-gap threshold. |
| `LOONGSUITE_PILOT_SELFCHECK_NEVER_COLLECTED_GRACE_MS` | Never-collected grace period. |
| `LOONGSUITE_PILOT_SELFCHECK_COOLDOWN_MS` | Alert cooldown. |

## Alert Output

Self-check emits alerts through the standard alarm pipeline via `AlarmManager.record`, using two alarm types:

- `SELF_CHECK_DATA_GAP_ALARM`
- `SELF_CHECK_NEVER_COLLECTED_ALARM`

Alarms are serialized to `pilot-alarms.jsonl` and reported to SLS under the `pilot_alarm` topic (same mechanism as all other alarms). Each entry carries `alarm_type`, `alarm_level`, `alarm_message`, `input_name` (the agent id), `user_id`, `ip`, `ver` (Pilot version), and `__time__`. The resolved **agent version** and **Pilot version** are embedded in `alarm_message` to help pinpoint whether an agent upgrade caused the break.

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
"versionSource": { "type": "jsonFile", "file": "~/.qoderwork/.status.json", "key": "version" }
"versionSource": { "type": "jsonlTail", "file": "~/.cursor/audit/audit.jsonl", "key": "cursor_version" }
"versionSource": { "type": "newestJsonFile", "dir": "~/.claude/sessions", "key": "version" }
"versionSource": { "type": "newestSubdirFile", "dir": "~/.qoder/logs/runs", "file": "manifest.json", "key": "cli_version" }
"versionSource": { "type": "command", "command": "opencode --version" }
```

| Type | Behavior |
|------|----------|
| `jsonFile` | Read `key` from a JSON file. |
| `jsonlTail` | Read `key` from the last valid line of a JSONL file. |
| `newestJsonFile` | Read `key` from the most recently modified (by mtime) `.json` file in `dir`. |
| `newestSubdirFile` | Read `key` from `file` inside the newest subdirectory of `dir`. |
| `command` | Run `command` and use the first line of stdout. |

If resolution fails, the version is reported as `unknown` and the alert is still emitted.

### Built-in Agent Signals

| Agent | activityIndicator | version source |
|-------|-------------------|----------------|
| Claude Code | `~/.claude/history.jsonl` | newest session json → `version` |
| Codex | `~/.codex/session_index.jsonl` | `codex --version` |
| Cursor | `~/.cursor/audit/audit.jsonl` | audit tail → `cursor_version` |
| Qoder | `~/.qoder/audit/audit.jsonl` | newest run `manifest.json` → `cli_version` |
| QoderWork | `~/.qoderwork/audit/audit.jsonl` | `~/.qoderwork/.status.json` → `version` |
| OpenCode | `~/.local/share/opencode/opencode.db-wal` | `opencode --version` |
| Qwen Code CLI | `~/.qwen/debug/latest` | `qwen --version` |
