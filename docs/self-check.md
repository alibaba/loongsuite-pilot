# Collection self-check

The self-check checks for recent native agent activity when a running Pilot input has gone quiet. Any eligible input for the same agent counts as collection progress. A listener is eligible while it is running and enabled by the current configuration, runtime controls, and deployment scope.

| Alarm | When Pilot records it |
| --- | --- |
| `SELF_CHECK_DATA_GAP_ALARM` | The agent previously produced entries in this collector process, its inputs have been quiet for the configured threshold, and its native activity file changed during the quiet period. |
| `SELF_CHECK_NEVER_COLLECTED_ALARM` | The agent has produced no entries in this collector process, the eligibility grace period has elapsed, and Pilot has observed recent native activity since that eligibility began. |
| `HOOK_REPAIR_ALARM` | The Hook watchdog completed a repair attempt. Level `1` indicates success and level `2` indicates failure. |

The native signal is the modification time of an agent's activity file. For Codex, a bounded read of the native thread index locates recent rollouts without reading their contents. This includes resumed sessions in old date directories. Missing signals and alternate Codex homes leave activity unverified. Pilot suppresses gap checks when workspace exclusions are configured because shared activity files do not identify which workspace changed. Hook repair reporting still follows the Hook watchdog configuration.

Gap alarm suppression applies per agent and alarm type during the current collector process. Restarting the collector starts a new eligibility window. A gap alarm includes the agent version when it can be established, and the Pilot version. This reports collection progress before export. Export and service restart failures have their own alarms.

Alarms use the existing `pilot_alarm` sender and `logs/metric_alarm/pilot-alarms-YYYY-MM-DD.jsonl` files. Each record uses the existing alarm fields.

## Configuration

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

| Field | Environment override |
| --- | --- |
| `enabled` | `LOONGSUITE_PILOT_SELFCHECK_ENABLED` |
| `intervalMs` | `LOONGSUITE_PILOT_SELFCHECK_INTERVAL_MS` |
| `dataGapThresholdMs` | `LOONGSUITE_PILOT_SELFCHECK_DATA_GAP_THRESHOLD_MS` |
| `neverCollectedGraceMs` | `LOONGSUITE_PILOT_SELFCHECK_NEVER_COLLECTED_GRACE_MS` |
| `cooldownMs` | `LOONGSUITE_PILOT_SELFCHECK_COOLDOWN_MS` |

## Agent signals

Agent definitions may provide an `activityIndicator` file and a `versionSource`. Pilot expands the home directory when resolving these paths.

| Agent | Activity file |
| --- | --- |
| Claude Code | `~/.claude/history.jsonl` |
| Codex | Rollouts under `~/.codex/sessions/` listed in `state_5.sqlite`, with `session_index.jsonl` as a legacy signal |
| Cursor | `~/.cursor/audit/audit.jsonl` |
| Qoder | `~/.qoder/audit/audit.jsonl` |
| Qoder Work | `~/.qoderwork/audit/audit.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db-wal` |
| Qwen Code CLI | `~/.qwen/debug/latest` |

`activityIndicator` accepts an activity file path or a `codexRollouts` source with a Codex home directory. `versionSource` supports `jsonFile`, `jsonlTail`, `newestJsonFile`, `newestSubdirFile`, and `command`. File and directory probes are bounded. Command probes support the built-in `codex --version`, `opencode --version`, and `qwen --version` commands. If resolution fails or the value does not resemble a version, the alarm uses `unknown`.
