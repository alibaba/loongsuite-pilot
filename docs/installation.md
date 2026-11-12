# Installation

English | [简体中文](zh-CN/installation.md)

Use this guide to install, verify, uninstall, or run LoongSuite Pilot from source.

## Prerequisites

- Linux/macOS: a system shell, `curl` or `wget`, and `tar`. Windows: PowerShell 5.1 or later.
- Pilot packages ship a Rust binary; installation configuration, collection, updating, CLI, and standalone hook processing need no Node.js, npm, Python, or Rust toolchain.
- Source builds use Rust 1.99.1 pinned in `rust-toolchain.toml`, a C/C++ compiler for bundled SQLite, and Swift for the macOS UI.
- In-process JS plugins, preload/runtime wrappers, and the Hermes Python plugin use the Agent's own runtime.

## Rust Packages And Platforms

The release set is Linux x86_64/aarch64 with GNU libc, macOS x86_64/aarch64, and Windows x86_64/aarch64 MSVC: six targets. Linux musl (including Alpine) is unsupported; the Unix installer rejects musl and unknown libc before downloading or changing an installation. Historical eight-target runs do not establish acceptance of the current six-target code.

Download the installer (`installer.sh` or `installer.ps1`), `SHA256SUMS`, and `loongsuite-pilot-<version>-<target>.tar.gz` (Windows: `.zip`) from the same Rust Release. Verify the archive checksum before explicitly installing it. For Linux x64 GNU:

```bash
sha256sum --ignore-missing --check SHA256SUMS
bash ./installer.sh install --package-url "file://$(pwd)/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu.tar.gz"
```

Use `Get-FileHash -Algorithm SHA256` on Windows and pass `-PackageUrl`; macOS can use `shasum -a 256`. Substitute the actual version and target. Packages include `runtime-manifest.json`; Rust updater accepts only the separate six-platform `latest-rust.json`, not legacy Node archives.

The OSS examples below describe the historical channel and are not guaranteed to return Rust packages. Pass an explicit, verified `--package-url` / `-PackageUrl` for Rust installation. This CI does not publish to OSS or migrate existing installations automatically. `.mjs` Span enrichers require migration to compiled Rust extensions; see [Trace output](trace-output.md#custom-span-enrichment).

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

The legacy default URL uses `loongsuite-pilot.zip`; Rust installation requires an explicitly selected versioned, target-specific zip. It stores data under `%USERPROFILE%\.loongsuite-pilot` and installs the `loongsuite-pilot` command under `%USERPROFILE%\.local\bin`. Open a new PowerShell window if the command is not found immediately after installation.

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
| `--agents <list>` | Comma-separated allowlist. Use `none` to disable all agents. Omit to continuously discover supported agents, including agents installed later. |
| `--multimodal-mode <mode>` | `none` / `input` / `output` / `all`. Writes that mode to selected `codex` and `qoder`; other existing supported agents get `none`. Without `--agents`, non-`none` writes that mode onto `codex` and `qoder` and creates missing entries. `none` deletes. Omit to leave unchanged. Non-`none` requires the four SLS flags. |
| `--userId <id>` | Set user identity written to output events. |
| `--data-dir <path>` | Override data directory. Default is `~/.loongsuite-pilot`. |
| `--enable-status-bar-app <true\|false>` | Set automatic macOS menu bar startup during `install`. Omission preserves the existing setting; fresh installs default to disabled. Windows: `-EnableStatusBarApp <true\|false>` (stores the setting; the UI is macOS-only). |
| `--dashboard-port <port>` | Optional Dashboard port, an integer from `1` to `65535`. Defaults to `8765` on first install; preserves the existing port on reinstall when omitted. Windows: `-DashboardPort <port>`. This setting only chooses the port. |
| `--package-url <url>` | Install from a custom URL or local `file://` path. |
| `--sls-endpoint <url>` | SLS endpoint URL. |
| `--sls-project <name>` | SLS project name. |
| `--sls-logstore <name>` | SLS logstore name. |
| `--sls-ak-id <key>` | SLS Access Key ID for AK mode. |
| `--sls-ak-secret <key>` | SLS Access Key Secret for AK mode. |
| `--sls-api-key <key>` | SLS API Key for API Key mode. Cannot be combined with AK/SK flags. |
| `--mask-mode <mode>` | Data masking mode: `all`, `none`, or `custom`. |
| `--mask-types <list>` | Comma-separated mask types. Required when `--mask-mode custom`. |
| `--mask-replacement-mode <mode>` | Mask replacement format: `placeholder` (fixed markers, default) or `preview` (star-masked previews). Windows: `-MaskReplacementMode`. |
| `--interceptor-mode <mode>` | Local interception mode: `all`, `none`, or `custom`. Enabled interceptor types are also added to `mask`. |
| `--interceptor-types <list>` | Comma-separated interceptor types (mask credential subset). Required when `--interceptor-mode custom`. |
| `--collect-log <true\|false>` | Enable or disable SLS log reporting. |
| `--collect-trace <true\|false>` | Enable or disable trace reporting. |
| `--cms-license-key <key>` | CMS or ARMS trace license key. |
| `--cms-endpoint <url>` | CMS or ARMS trace endpoint. |
| `--cms-workspace <name>` | CMS workspace value. |
| `--service-name-prefix <name>` | Service name prefix used by reporting backends. |
| `--system-service` | **Deprecated** — ignored. Init system is now auto-detected (systemd-user → systemd-system → init.d). |
| `--lang <lang>` | Output language: `zh` or `en`. |

Installation is non-interactive. The installer exits with an error when a required argument is missing or invalid.

For example, use port `9000` by appending `--dashboard-port 9000` (or `--dashboard-port=9000`) to the Linux/macOS install command, or `-DashboardPort 9000` to the Windows command. The installer writes `dashboard.port` to `config.json` before starting the service. Open `http://127.0.0.1:9000/` after installation. Invalid or missing port values stop installation before downloads or service changes.

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

The local dashboard is off by default. Set `"dashboard": {"enabled": true}` in `config.json` and restart the collector to enable it. It then starts and stops with the collector at the default address below or your configured port.

```text
http://127.0.0.1:8765/
```

The page reads `logs/metrics-summary.json` directly and does not run a second
aggregation pipeline.

### Start or stop the macOS menu bar app

To keep the menu bar closed from the first collector startup, add the option to the installation command:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --enable-status-bar-app false
```

The installer writes `"enableStatusBarApp": false` to `config.json` before starting collection. Explicit `true` re-enables automatic startup; omission preserves the existing value. This option applies to `install`, including reinstall; `upgrade` preserves the saved configuration. Collection and the local Dashboard remain enabled. The runtime environment variable `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` still takes precedence over this setting.

The menu bar app starts with the collector by default. Quitting it leaves collection running, so another `loongsuite-pilot start` does not reopen it. Use:

```bash
loongsuite-pilot menubar start
```

This persists `"enableStatusBarApp": true` in the active `config.json`, starts only the menu bar app, and reuses an existing instance. Run it in your macOS desktop terminal without `sudo`. The collector must already be running; otherwise run `loongsuite-pilot start`, wait for startup, and retry. If `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` disables the app, unset it or set it to `true` first. Startup logs are in `logs/app-status-bar/` under your data directory.

To close only the menu bar app:

```bash
loongsuite-pilot menubar stop
```

Collection keeps running. This also works when the collector is stopped or the menu bar app is disabled, and succeeds if the app is already stopped. It persists `"enableStatusBarApp": false`, so the next collector startup leaves the app closed.

`LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` keeps higher priority than the file. An environment value that enables the app can override the persisted `false` on future Pilot starts; the command prints a warning when it detects this conflict.

After a source build, `./target/release/loongsuite-pilot menubar start` and `./target/release/loongsuite-pilot menubar stop` provide the same commands without installing a new launcher.

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
The Rust CLI calls the macOS system osascript/JXA host directly. The bridge is embedded in the binary and the icon ships in the macOS package; Node.js is not required.

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

The web shortcut only stores a URL. It does not check whether Pilot is running
or whether another program has taken its port. Use `loongsuite-pilot status` to
check Pilot's status if the browser cannot open the expected page.

## Uninstall

Pilot leaves third-party legacy Codex OTel hooks, configuration, and the `~/.cache/opentelemetry.instrumentation.codex` directory untouched during startup and uninstall, including `--purge`.

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
cargo build --locked --release
./target/release/loongsuite-pilot
```

This starts the collector in the foreground. On startup, Pilot reads agent definitions from `agents.d/`, auto-detects installed agents, and deploys collection capabilities for detected agents.

## Install A Local Build As A Service

```bash
cargo build --locked --release --target x86_64-unknown-linux-gnu
cargo run --locked -p xtask -- package \
  --target x86_64-unknown-linux-gnu \
  --binary target/x86_64-unknown-linux-gnu/release/loongsuite-pilot \
  --commit "$(git rev-parse HEAD)" --output target/packages
bash deploy/installer-opensource.sh install --package-url "file://$(pwd)/target/packages/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu.tar.gz"
```

This example targets Linux x64 GNU. Package on the matching OS/architecture; macOS also requires a matching UI binary via `--status-bar-binary`. Cargo is the version source. Packaging rejects dirty trees unless `--allow-dirty` is explicitly supplied for local-only candidates; these cannot be released. Existing output directories are not overwritten.

See [release gates and test priorities](zh-CN/rust-release.md) for the staged CI rollout. `--version`, `probe --build-edition`, and `check --json` do not start services; installation and rollback modify local state and should be performed with retained backups.

## Next Steps

- Choose agents in [Agent Configuration](agents.md).
- Configure local output in [Local JSONL Output](local-jsonl-output.md).
- Configure SLS reporting in [SLS Output](sls-output.md).
- Configure trace reporting in [Trace Output](trace-output.md).
- Configure secret masking in [Data Masking](masking.md).
