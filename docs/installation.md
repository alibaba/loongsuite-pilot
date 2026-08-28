# Installation

English | [简体中文](zh-CN/installation.md)

Use this guide to install, verify, uninstall, or run LoongSuite Pilot from source.

## Prerequisites

- Node.js 18 or later
- `npm`
- `curl` or `wget`
- PowerShell 5.1 or later on Windows

## Install From Public Package On Linux Or macOS

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

The installer detects supported agents, lets you choose which agents to monitor, deploys hooks/plugins, writes the local configuration, and starts the background service.

## Install From Public Package On Windows

Run PowerShell and install from the published Windows package:

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer install
```

The Windows installer downloads `loongsuite-pilot.zip` by default. It stores data under `%USERPROFILE%\.loongsuite-pilot` and installs the `loongsuite-pilot` command under `%USERPROFILE%\.local\bin`. Open a new PowerShell window if the command is not found immediately after installation.

## Install With Common Options

Linux/macOS:

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install \
  --agents "claude-code,cursor,codex" \
  --userId "your-user-id" \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --mask-mode all
```

Windows PowerShell:

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer install `
  -Agents "claude-code,cursor,codex" `
  -UserId "your-user-id" `
  -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
  -SlsProject "my-project" `
  -SlsLogstore "my-logstore" `
  -MaskMode all
```

Installer options:

The Linux/macOS installer uses `--kebab-case` options. The Windows PowerShell installer uses the corresponding `-PascalCase` options, for example `--version` becomes `-Version` and `--data-dir` becomes `-DataDir`.

| Parameter | Description |
|-----------|-------------|
| `--version <ver>` | Install a specific version, for example `1.2.0`. |
| `--agents <list>` | Comma-separated agent list. Skips interactive selection. |
| `--userId <id>` | Set user identity written to output events. |
| `--data-dir <path>` | Override data directory. Default is `~/.loongsuite-pilot`. |
| `--package-url <url>` | Install from a custom URL or local `file://` path. |
| `--sls-endpoint <url>` | SLS endpoint URL. |
| `--sls-project <name>` | SLS project name. |
| `--sls-logstore <name>` | SLS logstore name. |
| `--sls-ak-id <key>` | SLS Access Key ID for AK mode. |
| `--sls-ak-secret <key>` | SLS Access Key Secret for AK mode. |
| `--sls-api-key <key>` | SLS API Key for API Key mode. Cannot be combined with AK/SK flags. |
| `--mask-mode <mode>` | Data masking mode: `all`, `none`, or `custom`. |
| `--mask-types <list>` | Comma-separated mask types. Required when `--mask-mode custom`. |
| `--collect-log <true\|false>` | Enable or disable SLS log reporting. |
| `--collect-trace <true\|false>` | Enable or disable trace reporting. |
| `--cms-license-key <key>` | CMS or ARMS trace license key. |
| `--cms-endpoint <url>` | CMS or ARMS trace endpoint. |
| `--cms-workspace <name>` | CMS workspace value. |
| `--service-name-prefix <name>` | Service name prefix used by reporting backends. |
| `--system-service` | **Deprecated** — ignored. Init system is now auto-detected (systemd-user → systemd-system → init.d). |
| `--lang <lang>` | Output language: `zh` or `en`. |

## Verify Installation

```bash
loongsuite-pilot status
loongsuite-pilot info
```

Local JSONL output is enabled by default:

```bash
ls ~/.loongsuite-pilot/logs/output
```

On Windows:

```powershell
Get-ChildItem "$env:USERPROFILE\.loongsuite-pilot\logs\output"
```

## Service Management

```bash
loongsuite-pilot start
loongsuite-pilot stop
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot token-usage
loongsuite-pilot rollback
```

The local dashboard starts and stops with the collector. Open:

```text
http://127.0.0.1:8765/
```

The page reads `logs/metrics-summary.json` directly and does not run a second
aggregation pipeline.

### macOS Dashboard launcher

The macOS installer creates `~/Applications/LoongSuite Pilot Dashboard.app` during
installation and refreshes it after a successful upgrade. Open it from Finder,
or drag it to the Dock. It uses your current default browser; it is separate from
the menu bar app and does not embed a browser or run in the background.

```bash
loongsuite-pilot dashboard open  # macOS: check the matching instance and open
loongsuite-pilot dashboard url   # Linux/macOS: print the configured URL
```

Every click reads `dashboard.port` from the installed configuration (normally
`~/.loongsuite-pilot/config.json`). A custom installer `--data-dir` is recorded
in the shortcut, so Finder does not need terminal environment variables. With
`"dashboard": { "port": 9000 }`, the URL is `http://127.0.0.1:9000/`. Missing or
invalid ports use `8765`, just like the collector. After editing the port,
restart Pilot to apply it; the app does not need rebuilding. The CLI also honors
`AGENT_DATA_COLLECTION_CONFIG` and `LOONGSUITE_PILOT_DATA_DIR`.

If the Dashboard is unavailable, the app offers Retry/Cancel without starting,
stopping, or restarting Pilot. It does not automatically open another service
or another Pilot instance occupying that port. A missing metrics snapshot does
not prevent opening a running Dashboard. The shortcut uses Pilot's installed
Node runtime, not a terminal PATH; it does not load the collector or its native
dependencies.

The app is generated locally with macOS system tools; users do not need Swift
or Xcode for this shortcut. Failure to create it does not fail Pilot installation.
Only a Pilot-managed app at that path is replaced or uninstalled; unrelated apps
are preserved. A moved/copied shortcut must be removed manually. Uninstalling a
custom installation requires the same `--data-dir` used for installation.
This is not a notarized, standalone downloadable app: it requires Pilot on the
same Mac and should be generated by each user's installer.

## Uninstall

Uninstall stops the service, removes installed files, and cleans the integrations written into agent configs (hook entries for Claude Code, Codex, Cursor, Qoder, Qwen, etc., and the injected plugin spec in OpenCode's config). Add `--purge` (`-Purge` on Windows) to also delete the local data directory.

Keep data on Linux/macOS:

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall
```

Remove installed files and local data on Linux/macOS:

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall --purge
```

Keep data on Windows:

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall
```

Remove installed files and local data on Windows:

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall -Purge
```

## Build And Run From Source

```bash
git clone https://github.com/alibaba/loongsuite-pilot.git
cd loongsuite-pilot
npm install
npm run build
node scripts/postinstall.js
node dist/index.js
```

This starts the collector in the foreground. On startup, Pilot reads agent definitions from `agents.d/`, auto-detects installed agents, and deploys collection capabilities for detected agents.

## Install A Local Build As A Service

```bash
bash deploy/package-opensource.sh
bash deploy/installer-opensource.sh --package-url "file://$(pwd)/loongsuite-pilot.tar.gz"
```

## Next Steps

- Choose agents in [Agent Configuration](agents.md).
- Configure local output in [Local JSONL Output](local-jsonl-output.md).
- Configure SLS reporting in [SLS Output](sls-output.md).
- Configure trace reporting in [Trace Output](trace-output.md).
- Configure secret masking in [Data Masking](masking.md).
