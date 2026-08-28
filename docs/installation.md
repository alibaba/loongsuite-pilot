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

### macOS Dashboard shortcut

Shortcut installation is **opt-in**. Normal Pilot installation, upgrades and
service starts do not create shortcuts or modify the Dock. This is separate
from the menu bar app.

```bash
loongsuite-pilot dashboard shortcut install
loongsuite-pilot dashboard shortcut status
loongsuite-pilot dashboard shortcut uninstall
```

`install` creates a radar-icon web shortcut at
`~/Library/Application Support/LoongSuite Pilot/Shortcuts/LoongSuite Pilot Dashboard.webloc`
and adds it to the Dock's files area (beside Downloads/Trash, not the applications
area). Clicking it uses the default browser. No `.app` is compiled or signed;
there is no additional software dependency, background process, or service restart.
The command uses Pilot's existing Node runtime and macOS system tools.

The URL is read from `dashboard.port` in the active configuration at **shortcut
installation time**. The CLI honors `AGENT_DATA_COLLECTION_CONFIG` and the installed
custom data directory; missing/invalid ports use the collector's default of
`8765`. For example, port `9000` produces `http://127.0.0.1:9000/`.
A `.webloc` stores a URL, not executable code: after changing the port, restart
Pilot as usual and rerun `dashboard shortcut install` to update the shortcut.
Repeated installation keeps the existing Dock position and does not add duplicates.
Upgrades/startup never silently re-add a shortcut you removed.

`status` is a read-only terminal report of the shortcut file path, **stored target
URL**, and Dock presence. It is not a service-health check. `uninstall` removes only
the matching managed Dock entry and moves the matching shortcut file to Trash;
it does not uninstall Pilot. Run it before uninstalling Pilot itself, or remove
the shortcut manually afterwards. Copies/moved files are not managed.

Only shortcuts marked as Pilot-managed for the same configuration are replaced
or removed. Unrelated files, symbolic links, other configurations, and locked or
managed Dock layouts are preserved. If the file is already missing, an orphaned
Dock item is reported for manual removal. Dock changes are backed up in the
shortcut directory's `Backups` subdirectory; uninstall keeps these backups.
The Dock preference format is not a public Apple API: layout changes are checked
before/after writing, and unsupported layouts fail rather than being overwritten.
The Dock briefly refreshes when an entry or icon changes.

The web shortcut does not check whether Pilot is running or whether another
program has taken its port. For a checked, configuration-aware open on every
invocation (without installing a shortcut), use:

```bash
loongsuite-pilot dashboard open  # macOS: verify the matching Pilot instance and open
loongsuite-pilot dashboard url   # Linux/macOS: print the current configured URL
```

These commands do not start or stop the collector, load its native dependencies,
or rewrite the Node runtime pin. A matching Dashboard can be opened before its
first metrics snapshot is ready.

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
