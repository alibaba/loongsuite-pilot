# LoongSuite Pilot

A lightweight, multi-agent AI coding telemetry collector. LoongSuite Pilot discovers, hooks, and normalizes activity data from various AI coding agents, then outputs it to pluggable backends (JSONL, SLS, HTTP, OTLP).

## Supported Agents

| Agent | Collection Method |
|-------|------------------|
| Claude Code | Hook JSONL logs |
| Codex | CLI telemetry log forwarding |
| Cursor | Hook JSONL logs |
| Qoder | IDE history snapshot polling |
| QoderCN | SQLite incremental polling |
| QoderWork | Hook JSONL logs |

Agent support is declarative — see `agents.d/` for definitions. Adding a new agent requires no changes to the core framework.

## Prerequisites

- **Node.js** >= 18
- **npm**
- **curl** or **wget** (for installer)

## Installation

### Option 1: Install from GitHub Releases (Recommended)

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

The installer detects installed agents, lets you choose which to monitor, deploys hooks, and registers a background service.

#### Installer Options

All parameters are optional and can be combined:

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install \
  --version 1.2.0 \
  --agents "claude-code,cursor,qoder-work" \
  --userId "your-user-id" \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --mask-mode all
```

| Parameter | Description |
|-----------|-------------|
| `--version <ver>` | Install a specific version (e.g. `1.2.0`) |
| `--agents <list>` | Comma-separated agent list (skips interactive selection) |
| `--userId <id>` | Set user identity |
| `--data-dir <path>` | Override data directory (default: `~/.loongsuite-pilot`) |
| `--package-url <url>` | Install from a custom URL or local `file://` path |
| `--sls-endpoint <url>` | SLS endpoint URL |
| `--sls-project <name>` | SLS project name |
| `--sls-logstore <name>` | SLS logstore name |
| `--sls-ak-id <key>` | SLS Access Key ID (for AK mode) |
| `--sls-ak-secret <key>` | SLS Access Key Secret (for AK mode) |
| `--mask-mode <mode>` | Data masking mode: `all`, `none`, or `custom` |
| `--log-level <level>` | Log level: `debug`, `info`, `warn`, `error` |
| `--system-service` | Register as system-level service (instead of user-level) |
| `--lang <lang>` | Output language: `zh` or `en` |

Uninstall:

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall          # keep data
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall --purge  # remove all data
```

### Option 2: Build from Source

```bash
git clone https://github.com/loongsuite/loongsuite-pilot.git
cd loongsuite-pilot
npm install
npm run build

# Deploy hook scripts to ~/.loongsuite-pilot/hooks/
node scripts/postinstall.js

# Start the collector (foreground)
node dist/index.js
```

On startup the collector reads all agent definitions from `agents.d/`, auto-detects which agents are installed on your machine, and deploys hooks for them. There is no way to select specific agents in this mode — all detected agents are monitored. To disable a specific agent, set it to `"off"` in `~/.loongsuite-pilot/agent-control.json` (see [Agent Admission Control](#agent-admission-control)).

To run as a background service instead, package and install locally:

```bash
bash deploy/package.sh --opensource
bash deploy/installer-opensource.sh --package-url "file://$(pwd)/loongsuite-pilot.tar.gz"
```

### Service Management

After installation, use the `loongsuite-pilot` command:

```bash
loongsuite-pilot start    # Start the collector
loongsuite-pilot stop     # Stop the collector
loongsuite-pilot restart  # Restart the collector
loongsuite-pilot status   # Detailed process status
loongsuite-pilot info     # Show version and config
loongsuite-pilot rollback # Rollback to previous version
```

## Configuration

Configuration priority: **environment variables > config file > built-in defaults**.

Default config path: `~/.loongsuite-pilot/config.json` (override via `AGENT_DATA_COLLECTION_CONFIG` env var).

```jsonc
{
  "enabled": true,
  "dataDir": "~/.loongsuite-pilot",
  "userId": "your-user-id",

  // SLS output (optional — requires Alibaba Cloud SLS)
  "sls": {
    "enabled": true,
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "my-project",
    "logstore": "my-logstore",
    "mode": "webtracking",
    "batchMaxSize": 20,
    "flushIntervalMs": 2000
  },

  // Local JSONL file output (enabled by default)
  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/event_log"
  },

  // HTTP POST output (optional)
  "http": {
    "enabled": false,
    "url": "https://your-endpoint.com/api/events",
    "headers": { "Authorization": "Bearer xxx" },
    "batchMaxSize": 50,
    "flushIntervalMs": 5000
  },

  // Per-agent content capture control
  "agents": {
    "claude-code": { "captureMessageContent": false },
    "cursor": { "captureMessageContent": true }
  },

  // Data masking
  "mask": {
    "mode": "all"  // "all" | "none" | "custom"
  }
}
```

### Output Backends

| Backend | Class | Description |
|---------|-------|-------------|
| **JSONL** (default) | `JsonlFlusher` | Local file, daily rotation by `{agentType}-{YYYY-MM-DD}.jsonl` |
| **SLS** | `SlsFlusher` | Alibaba Cloud Log Service, batched, with health check and retry |
| **HTTP** | `HttpFlusher` | POST to any HTTP endpoint, batched with auto-retry |
| **OTLP Trace** | `OtlpTraceFlusher` | OpenTelemetry trace export via OTLP/HTTP |

If no backend is configured, the collector defaults to JSONL local file output.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_DATA_COLLECTION_CONFIG` | Path to config file |
| `LOONGSUITE_PILOT_ENABLED` | Enable/disable collector (`true`/`false`) |
| `LOONGSUITE_PILOT_DATA_DIR` | Data directory path |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`, `silent`) |
| `JSONL_ENABLED` | Enable JSONL output |
| `JSONL_OUTPUT_DIR` | JSONL output directory |
| `HTTP_REPORT_URL` | HTTP output endpoint URL |
| `HTTP_REPORT_HEADERS` | HTTP output headers (JSON string) |

## How It Works

1. **Agent Discovery**: On startup, Pilot reads agent definitions from `agents.d/*.json` and checks whether each agent is installed (by looking for known paths or commands).
2. **Hook Deployment**: For detected agents, Pilot installs hooks (e.g. writing to the agent's `settings.json`) so that agent activity is captured to local JSONL files.
3. **Data Collection**: Inputs tail hook output files, poll SQLite databases, or forward CLI logs — depending on the agent's collection method.
4. **Normalization**: Raw events are normalized into a unified `AgentActivityEntry` schema.
5. **Output**: Normalized events are flushed to configured backends (JSONL, SLS, HTTP, OTLP).

Agent definitions in `agents.d/` are declarative JSON files that describe how to detect and hook each agent. The collector handles the rest automatically.

## Project Structure

```
src/
├── index.ts                          # Main entry point
├── core/
│   ├── orchestrator.ts               # Central orchestrator (wires all subsystems)
│   ├── input-manager.ts              # Input source lifecycle + dispatch
│   ├── agent-discovery-service.ts    # Agent discovery (fs.watch + polling)
│   ├── agent-control-manager.ts      # Agent admission control (on/off/auto)
│   └── config-loader.ts             # Config loading (env + file + defaults)
├── inputs/
│   ├── base/                         # 6 collection method base classes
│   │   ├── base-input.ts             #   Root abstract class
│   │   ├── base-ide-input.ts         #   IDE history snapshot polling
│   │   ├── base-sqlite-input.ts      #   SQLite incremental polling
│   │   ├── base-hook-input.ts        #   Hook JSONL logs
│   │   ├── base-cli-forwarder.ts     #   CLI telemetry log forwarding
│   │   └── base-session-input.ts     #   Session file polling
│   ├── claude-code-log/              # Claude Code input
│   ├── codex-log/                    # Codex input
│   ├── cursor-hook/                  # Cursor input
│   ├── qoder/                        # Qoder IDE input
│   └── ...                           # Other agent inputs
├── flushers/
│   ├── base-flusher.ts               # Abstract flusher interface
│   ├── sls-flusher.ts                # Alibaba Cloud SLS output
│   ├── jsonl-flusher.ts              # Local JSONL file output
│   ├── http-flusher.ts               # HTTP POST output
│   ├── otlp-trace-flusher.ts         # OTLP trace export
│   └── multi-flusher.ts              # Multi-target fan-out
├── normalization/                    # Data normalization layer
├── checkpoints/                      # Persistence (state + snapshot stores)
├── hooks/                            # Hook script management
├── mask/                             # Sensitive data masking
├── metrics/                          # Runtime metrics and alarms
├── deployment/                       # Agent detection and hook deployment
└── updater/                          # Self-update mechanism

agents.d/                            # Agent definitions (declarative JSON)
├── claude-code.json
├── cursor.json
├── qoder.json
├── qoder-cn.json
├── qoder-work.json
└── codex.json
```

## Development

```bash
npm install               # Install dependencies
npm run build             # Build with esbuild (3 bundles)
npm run typecheck         # Type check (tsc --noEmit)
npm test                  # Run tests (Vitest)
npm run test:coverage     # Run tests with coverage
```

### Build Variants

The build system supports a `BUILD_TYPE` environment variable for vendor-specific extensions:

```bash
npm run build                      # Standard build (open-source)
BUILD_TYPE=internal npm run build  # Internal build with vendor extensions
```

## Extension Guide

### Adding a New Agent

1. **Create an agent definition** in `agents.d/my-agent.json`:

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.my-agent"],
    "commands": []
  },
  "hook": {
    "settingsPath": "~/.my-agent/settings.json",
    "events": ["Stop"],
    "hookCommand": "$PILOT_DATA/hooks/my-agent-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent/history"
  }
}
```

2. **Implement an Input class** extending the appropriate base class:

| Base Class | Override Methods | Use Case |
|------------|-----------------|----------|
| `BaseIdeInput` | `scanHistoryEntries()`, `buildEntry()` | IDE history polling |
| `BaseSqliteInput` | `readNewRows()`, `transformRow()` | SQLite incremental query |
| `BaseHookInput` | `transformRecord()` | Hook JSONL log tailing |
| `BaseCliForwarder` | `isRelevantEvent()`, `transformPayload()` | CLI telemetry forwarding |
| `BaseSessionInput` | `discoverSessionFiles()`, `processSessionLine()` | Session file polling |

3. **Register** in `src/core/orchestrator.ts` via `inputManager.registerInput()`

### Adding a New Output Backend

1. Extend `BaseFlusher` and implement `send()` / `sendBatch()` / `flush()` / `shutdown()`
2. Add to the flusher array in `orchestrator.ts` `buildFlusher()`

### Agent Admission Control

Edit `~/.loongsuite-pilot/agent-control.json`:

```json
{
  "claude-code": "on",
  "cursor": "auto",
  "qoder": "off"
}
```

Modes: `"on"` (force enable), `"off"` (force disable), `"auto"` (auto-detect, default).

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
