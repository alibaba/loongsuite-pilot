# 安装指南

[English](../installation.md) | 简体中文

本文说明如何安装、验证、卸载 LoongSuite Pilot，或从源码运行。

Claude Agent SDK 使用自定义 `CLAUDE_CONFIG_DIR` 时，可在启动会话前执行 [`loongsuite-pilot inject`](claude-session-injection.md) 合并采集 Hook。

## 前置要求

- Linux/macOS：系统 Shell、`curl` 或 `wget`、`tar`；Windows：PowerShell 5.1 或以上版本。
- 安装包自带 Rust 二进制；Pilot 的安装配置处理、collector、updater、CLI 和独立 Hook processor 不依赖 Node.js、npm、Python 或 Rust 工具链。
- 仅源码开发需要 `rust-toolchain.toml` 固定的 Rust 1.99.1、C/C++ 编译器（SQLite bundled）及 macOS UI 的 Swift 工具链。
- Agent 进程内的 JS 插件、preload、runtime wrapper 和 Hermes Python 插件仍由各 Agent 宿主执行。

## Rust 发行包与平台

当前固定支持以下六个平台。Linux 仅支持 GNU libc；musl（包括 Alpine）不受支持，Unix 安装器在下载或修改安装态前拒绝 musl 和无法确认的 libc。历史八平台运行、Node 支持声明或 Linux 单测不能替代当前六平台代码的验收。

| 系统 | target triple | 格式 |
|---|---|---|
| Linux x64 | `x86_64-unknown-linux-gnu` | tar.gz |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | tar.gz |
| macOS Intel / Apple Silicon | `x86_64-apple-darwin`、`aarch64-apple-darwin` | tar.gz |
| Windows x64 / ARM64 | `x86_64-pc-windows-msvc`、`aarch64-pc-windows-msvc` | zip |

从同一 Rust Release 下载 `installer.sh` / `installer.ps1`、`SHA256SUMS` 和 `loongsuite-pilot-<version>-<target>.<格式>`；先核对 SHA-256，再显式安装本地包。例如 Linux x64 GNU：

```bash
sha256sum --ignore-missing --check SHA256SUMS
bash ./installer.sh install --package-url "file://$(pwd)/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu.tar.gz"
```

Windows 使用 `Get-FileHash -Algorithm SHA256` 与清单逐字核对，再使用 `-PackageUrl` 传入对应 zip。macOS 可用 `shasum -a 256` 核对。版本号和 target 必须替换为实际下载值。

下面的 OSS 示例保留用于历史版本；旧默认地址不保证返回 Rust 包，Rust 安装应显式传入已核验的 `--package-url` / `-PackageUrl`。本次 CI 不上传 OSS，也不自动切换既有安装或更新渠道。

## 在 Linux 或 macOS 从公开包安装

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

安装器会检测支持的 Agent，让你选择要监控的 Agent，部署 Hook 或插件，写入本地配置，并启动后台服务。

## 在 Windows 从公开包安装

打开 PowerShell，执行：

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer install
```

历史默认地址使用通用 `loongsuite-pilot.zip`；Rust 发行必须显式选择带版本及 target 的 zip。数据目录默认在 `%USERPROFILE%\.loongsuite-pilot`，命令入口安装到 `%USERPROFILE%\.local\bin`。如果安装后当前窗口里找不到 `loongsuite-pilot` 命令，重新打开一个 PowerShell 窗口即可。

## 带常用参数安装

Linux/macOS：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install \
  --agents "claude-code,cursor,codex" \
  --userId "your-user-id" \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --mask-mode all
```

Windows PowerShell：

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

安装参数：

Linux/macOS 安装器使用 `--kebab-case` 参数；Windows PowerShell 安装器使用对应的 `-PascalCase` 参数，例如 `--version` 对应 `-Version`，`--data-dir` 对应 `-DataDir`。

| 参数 | 说明 |
|------|------|
| `--version <ver>` | 安装指定版本，例如 `1.2.0`。 |
| `--agents <list>` | 逗号分隔的 Agent 列表，指定允许采集的 Agent，`none` 表示不启用任何 Agent。省略时持续发现受支持的 Agent，包括运行后安装的 Agent。 |
| `--multimodal-mode <mode>` | `none` / `input` / `output` / `all`。已选的 `codex`、`qoder` 写该模式，其他已有 supported 写 `none`。省略 `--agents` 且该模式非 `none` 时，`codex`、`qoder` 都写该模式（没有条目则补上）。值为 `none` 则删除。不传不改。非 `none` 须带齐 SLS 四字段。 |
| `--userId <id>` | 设置写入输出事件的用户标识。 |
| `--data-dir <path>` | 覆盖数据目录，默认 `~/.loongsuite-pilot`。 |
| `--enable-status-bar-app <true\|false>` | 在 `install` 时设置是否自动启动 macOS 菜单栏。未传时保留已有配置，首次安装默认关闭。Windows 对应 `-EnableStatusBarApp <true\|false>`（保存配置，菜单栏仅支持 macOS）。 |
| `--dashboard-port <port>` | 可选的 Dashboard 端口，取值为 `1–65535` 的整数。首次安装不指定时使用 `8765`；重新安装不指定时保留已有端口。Windows 对应 `-DashboardPort <port>`。此参数仅设置端口。 |
| `--package-url <url>` | 从自定义 URL 或本地 `file://` 路径安装。 |
| `--sls-endpoint <url>` | SLS endpoint。 |
| `--sls-project <name>` | SLS project。 |
| `--sls-logstore <name>` | SLS logstore。 |
| `--sls-ak-id <key>` | AK 模式的 Access Key ID。 |
| `--sls-ak-secret <key>` | AK 模式的 Access Key Secret。 |
| `--sls-api-key <key>` | API Key 模式的 SLS API Key，不能和 AK/SK 参数同时使用。 |
| `--mask-mode <mode>` | 脱敏模式：`all`、`none` 或 `custom`。 |
| `--mask-types <list>` | 逗号分隔的脱敏类型，`--mask-mode custom` 时必填。 |
| `--mask-replacement-mode <mode>` | 脱敏替换格式：`placeholder`（默认固定占位符）或 `preview`（星号预览）。Windows 对应 `-MaskReplacementMode`。 |
| `--interceptor-mode <mode>` | 本地拦截模式：`all`、`none` 或 `custom`。启用的拦截类型会自动补进 `mask`。 |
| `--interceptor-types <list>` | 逗号分隔的拦截类型（mask 密钥子集），`--interceptor-mode custom` 时必填。 |
| `--collect-log <true\|false>` | 开启或关闭 SLS 日志上报。 |
| `--collect-trace <true\|false>` | 开启或关闭 Trace 上报。 |
| `--cms-license-key <key>` | CMS 或 ARMS Trace license key。 |
| `--cms-endpoint <url>` | CMS 或 ARMS Trace endpoint。 |
| `--cms-workspace <name>` | CMS workspace 值。 |
| `--service-name-prefix <name>` | 上报后端使用的 service name 前缀。 |
| `--system-service` | **已废弃** — 忽略。Init 系统现在自动检测（systemd-user → systemd-system → init.d）。 |
| `--prefer-system-node` | 旧版兼容参数；Rust 原生安装无需选择或下载 Node。 |
| `--lang <lang>` | 输出语言：`zh` 或 `en`。 |

安装全程无需交互。参数缺失或无效时，安装器会报错退出。

例如要使用 `9000` 端口，在 Linux/macOS 安装命令末尾加 `--dashboard-port 9000`（也支持 `--dashboard-port=9000`）；Windows 则加 `-DashboardPort 9000`。安装器会在启动服务前，将端口写入 `config.json` 的 `dashboard.port`。启用 Dashboard 后访问 `http://127.0.0.1:9000/`。传入非法端口或只写参数却没有提供值时，会在下载、修改服务之前报错退出。

## 运行时

安装后的采集进程、更新进程和 Hook 处理都是 `loongsuite-pilot` 二进制。版本目录是 `~/.loongsuite-pilot/versions/<版本>/`，其中 `bin/loongsuite-pilot` 是原生外壳，实际加载同目录的 Rust SDK 动态库（Linux .so、macOS .dylib、Windows .dll），两者必须一起保留；`current` 指向正在使用的版本名。`~/.local/bin/loongsuite-pilot` 是启动脚本，`run` 和 `run-updater` 会执行这个二进制。

版本包通过 `runtime-manifest.json` 记录平台、edition、提交和资源摘要；Rust updater 只接受独立的 `latest-rust.json` 六平台清单，不接受旧 Node 通用包。首次从 Node 版迁移必须使用 Rust 安装器和匹配的平台包，不直接混用旧自动更新渠道。

仍保留的 JavaScript/Python 仅用于 Agent 宿主插件、preload 和 runtime wrapper；Dashboard 为静态前端，macOS 菜单栏为预编译 Swift UI。Pilot 内部 `.mjs` Span enricher 已不支持，见 [Trace 扩展迁移](trace-output.md#自定义-span-属性补齐)。

`loongsuite-pilot --version`、`probe --build-edition`、`check --json` 可做无启动副作用的检查。版本切换、回滚和卸载会修改本地安装，应在保留配置与旧版本备份后明确执行；包预检不代表全生命周期验收。

## 验证安装

```bash
loongsuite-pilot status
loongsuite-pilot info
```

默认启用本地 JSONL 输出：

```bash
ls ~/.loongsuite-pilot/logs/output
```

Windows 下使用：

```powershell
Get-ChildItem "$env:USERPROFILE\.loongsuite-pilot\logs\output"
```

## 服务管理

```bash
loongsuite-pilot start
loongsuite-pilot stop
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot token-usage
loongsuite-pilot rollback
```

本地 Dashboard 默认关闭。在 `config.json` 中设置 `"dashboard": {"enabled": true}` 并重启采集服务即可启用。启用后随采集服务启动和停止，默认地址如下。

```text
http://127.0.0.1:8765/
```

页面直接读取 `logs/metrics-summary.json`，不会另起一套聚合计算。

### 手动启动和停止 macOS 菜单栏

如果希望首次启动采集服务时就不显示菜单栏，在安装命令中添加：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --enable-status-bar-app false
```

安装器会在启动采集服务前将 `"enableStatusBarApp": false` 写入 `config.json`。显式传 `true` 可恢复自动启动，不传则保留已有值。该参数用于 `install`，也适用于覆盖安装；`upgrade` 保留已保存的配置。采集服务和本地 Dashboard 不受影响。运行时环境变量 `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` 仍优先于此配置。

菜单栏默认随采集服务启动。菜单栏里的“退出”只会关闭菜单栏，采集服务继续运行；此时再次执行 `loongsuite-pilot start` 不会重新打开菜单栏。请执行：

```bash
loongsuite-pilot menubar start
```

该命令会向当前生效的 `config.json` 持久化 `"enableStatusBarApp": true`，然后只启动菜单栏，不会重启采集服务；菜单栏已运行时会提示现有进程，不重复启动。请在 macOS 桌面用户的终端执行，不要使用 `sudo`。

如果提示采集服务未运行，请先执行 `loongsuite-pilot start`，等服务启动完成后重试。如果设置了 `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP=false`，需先取消或改为 `true`。启动失败时查看数据目录下的 `logs/app-status-bar/` 日志。

只关闭菜单栏、保留采集服务：

```bash
loongsuite-pilot menubar stop
```

采集服务未运行或菜单栏已被配置禁用时，也可用此命令清理残留的菜单栏进程；菜单栏已退出时会正常返回。命令会持久化 `"enableStatusBarApp": false`，下次启动采集服务时不会再自动打开菜单栏。

环境变量 `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` 的优先级仍高于配置文件。如果它设置为启用，后续启动 Pilot 时仍可覆盖持久化的 `false`；命令检测到冲突时会给出警告。

源码构建后也可执行 `./target/release/loongsuite-pilot menubar start` 或 `./target/release/loongsuite-pilot menubar stop`。

### macOS Dashboard 快捷方式

快捷方式**按需安装**：普通安装、升级和启动 Pilot 都不会创建快捷方式或修改程序坞。
它与菜单栏 App 相互独立。

```bash
loongsuite-pilot dashboard shortcut install
loongsuite-pilot dashboard shortcut status
loongsuite-pilot dashboard shortcut uninstall
```

`install` 会创建带雷达图标的网页快捷方式：
`~/Library/Application Support/LoongSuite Pilot/Shortcuts/LoongSuite Pilot Dashboard.webloc`，
并添加到程序坞的文件区（下载、废纸篓这一侧，不能放在应用区）。点击后使用默认浏览器打开。
不生成或编译 `.app`，不需要额外安装软件，不增加后台进程，也不会重启 Pilot。
安装命令由 Rust CLI 调用 macOS 自带的 osascript/JXA，不依赖 Node.js；桥接代码内嵌于二进制，图标随 macOS 平台包提供。

网址在**执行快捷方式安装命令时**读取配置中的 `dashboard.port`，支持
`AGENT_DATA_COLLECTION_CONFIG` 和安装时的自定义数据目录；端口缺失或不合法时，
与采集服务一样使用 `8765`。例如配置端口 `9000`，生成的网址就是
`http://127.0.0.1:9000/`。
`.webloc` 保存的是网址，不会执行读取配置的代码。因此修改端口并重启 Pilot 后，
需要再执行一次 `dashboard shortcut install` 更新网址；重复安装会保留原来的程序坞位置，
不会重复添加。用户移除的入口也不会在升级或启动时被自动加回来。

`status` 只在终端显示快捷文件位置、**文件里保存的目标网址**和是否已添加到程序坞，
不是服务健康检查。`uninstall` 只移除对应程序坞入口，并把受管理的快捷文件移到废纸篓，
不会卸载 Pilot。建议卸载 Pilot 本体前先执行此命令；之后也可以手动删除快捷文件和入口。
自行移动或复制的文件不受命令管理。

仅更新或移除带 Pilot 管理标记、且属于同一配置路径的快捷方式；不覆盖同名用户文件、
符号链接或另一套配置的快捷方式，不修改被管理策略锁定的程序坞。若快捷文件已经丢失，
会提示手动移除残留入口。修改程序坞前会把布局备份到快捷目录的 `Backups` 子目录，
卸载快捷方式时保留备份。程序坞配置格式不是 Apple 公开接口，因此会在写入前后检查布局，
遇到不支持的格式直接报错，不覆盖原布局。入口或图标变化时程序坞会短暂刷新。

网页快捷方式只保存网址，不会判断 Pilot 是否正在运行，也不会识别端口是否被其他程序占用。
浏览器无法打开预期页面时，可用 `loongsuite-pilot status` 检查 Pilot 状态。

## 卸载

Pilot 启动和卸载时保留第三方旧 Codex OTel Hook、配置及 `~/.cache/opentelemetry.instrumentation.codex` 目录，`--purge` 也不删除这些资产。

卸载会停止服务、删除已安装文件，并清理写入各 agent 配置中的接入内容（Claude Code、Codex、Cursor、Qoder、Qwen 等的 hook 条目，以及注入到 OpenCode 配置里的插件 spec）。加 `--purge`（Windows 为 `-Purge`）可一并删除本地数据目录。

Linux/macOS 保留数据：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall
```

Linux/macOS 移除安装文件和本地数据：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall --purge
```

Windows 保留数据：

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall
```

Windows 移除安装文件和本地数据：

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1" `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall -Purge
```

## 从源码构建并运行

```bash
git clone https://github.com/alibaba/loongsuite-pilot.git
cd loongsuite-pilot
cargo build --locked --release --lib --bin loongsuite-pilot
./target/release/loongsuite-pilot
```

这会以前台方式启动 collector。启动时，Pilot 会读取 `agents.d/` 中的 Agent 定义，自动检测已安装 Agent，并为检测到的 Agent 部署采集能力。

## 将本地构建安装为服务

```bash
cargo build --locked --release --target x86_64-unknown-linux-gnu
cargo run --locked -p xtask -- package \
  --target x86_64-unknown-linux-gnu \
  --binary target/x86_64-unknown-linux-gnu/release/loongsuite-pilot \
  --commit "$(git rev-parse HEAD)" --output target/packages
bash deploy/installer-opensource.sh install --package-url "file://$(pwd)/target/packages/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu/loongsuite-pilot-1.2.0-x86_64-unknown-linux-gnu.tar.gz"
```

上述示例仅适用于 Linux x64 GNU，其他平台需要在对应 OS/架构打包；macOS 还必须通过 `--status-bar-binary` 提供同架构 UI。打包默认拒绝未提交修改；本地调试可显式 `--allow-dirty`，这样的包不能发布。版本以 Cargo 为准，输出目录已存在时拒绝覆盖。

发布工作流与测试优先级见 [Rust 发布与测试优先级](rust-release.md)。

## 下一步

- 在 [Agent 配置](agents.md) 选择 Agent。
- 在 [本地 JSONL 输出](local-jsonl-output.md) 验证本地输出。
- 在 [SLS 输出](sls-output.md) 配置 SLS 上报。
- 在 [Trace 输出](trace-output.md) 配置 Trace 上报。
- 在 [数据脱敏](masking.md) 配置密钥脱敏。
