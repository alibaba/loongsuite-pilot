# 安装指南

[English](../installation.md) | 简体中文

本文说明如何安装、验证、卸载 LoongSuite Pilot，或从源码运行。

## 前置要求

- `curl` 或 `wget`
- Windows 下需要 PowerShell 5.1 或更高版本
- Node.js 18+ 与 `npm`：在受支持平台上由安装器自动下载**托管 Node.js 运行时**（见下文），无需预装；Linux musl（Alpine）与 Windows ARM64 等不受支持平台仍需自备 Node.js 18+ 与 `npm`

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

Windows 安装器默认下载 `loongsuite-pilot.zip`。数据目录默认在 `%USERPROFILE%\.loongsuite-pilot`，命令入口安装到 `%USERPROFILE%\.local\bin`。如果安装后当前窗口里找不到 `loongsuite-pilot` 命令，重新打开一个 PowerShell 窗口即可。

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
| `--agents <list>` | 逗号分隔的 Agent 列表，跳过交互选择。 |
| `--userId <id>` | 设置写入输出事件的用户标识。 |
| `--data-dir <path>` | 覆盖数据目录，默认 `~/.loongsuite-pilot`。 |
| `--package-url <url>` | 从自定义 URL 或本地 `file://` 路径安装。 |
| `--sls-endpoint <url>` | SLS endpoint。 |
| `--sls-project <name>` | SLS project。 |
| `--sls-logstore <name>` | SLS logstore。 |
| `--sls-ak-id <key>` | AK 模式的 Access Key ID。 |
| `--sls-ak-secret <key>` | AK 模式的 Access Key Secret。 |
| `--sls-api-key <key>` | API Key 模式的 SLS API Key，不能和 AK/SK 参数同时使用。 |
| `--mask-mode <mode>` | 脱敏模式：`all`、`none` 或 `custom`。 |
| `--mask-types <list>` | 逗号分隔的脱敏类型，`--mask-mode custom` 时必填。 |
| `--collect-log <true\|false>` | 开启或关闭 SLS 日志上报。 |
| `--collect-trace <true\|false>` | 开启或关闭 Trace 上报。 |
| `--cms-license-key <key>` | CMS 或 ARMS Trace license key。 |
| `--cms-endpoint <url>` | CMS 或 ARMS Trace endpoint。 |
| `--cms-workspace <name>` | CMS workspace 值。 |
| `--service-name-prefix <name>` | 上报后端使用的 service name 前缀。 |
| `--system-service` | **已废弃** — 忽略。Init 系统现在自动检测（systemd-user → systemd-system → init.d）。 |
| `--prefer-system-node` | 优先使用系统已安装的 Node.js，仅当系统没有可用 node 时才下载托管运行时（默认行为是始终下载并固定托管运行时）。 |
| `--lang <lang>` | 输出语言：`zh` 或 `en`。 |

## 托管 Node.js 运行时

为避免「用户环境删除/切换 node 导致采集中断」，安装器默认从 OSS 下载并固定一份**托管 Node.js 运行时**与**预编译 node_modules**，采集运行时不再依赖系统 node：

1. `ensure_managed_node`：按平台/架构下载 `node-v<版本>-<os>-<arch>` 包，校验 `SHASUMS256.txt` 后解压到 `<数据目录>/runtime/`，并把该 node 路径写入 `<数据目录>/node-bin`。macOS 会执行 `xattr -dr com.apple.quarantine` 去除隔离属性。
2. `ensure_node_modules`：按 app 版本 × 平台 × 架构下载预编译 `node_modules`（含原生模块 `sqlite3`、`zstd-napi`），校验后替换安装目录下的 `node_modules`。
3. 任一步失败都会回退到旧路径（`resolve_node` 找系统 node / `npm install --production --no-optional`），都不会硬失败；彻底无路可走才报错退出。

平台覆盖与回退：

| 平台/arch | 托管 node | 托管 node_modules | 行为 |
|---|---|---|---|
| macOS arm64 / x64 | ✅ | ✅ | 托管下载 |
| Linux x64 / arm64（glibc） | ✅ | ✅ | 托管下载 |
| Windows x64 | ✅ | ✅ | 托管下载 |
| Linux musl（Alpine） | ❌ | ❌ | 回退系统 node + `npm install`，安装器会明确提示 |
| Windows ARM64 | ❌ | ❌ | 回退系统 node + `npm install`，安装器会明确提示 |

本地布局：

```text
~/.loongsuite-pilot/
├── node-bin                       # 固定的 node 路径（默认指向 runtime/ 下的托管 node）
└── runtime/
    └── node-v22.22.2-darwin-arm64/
        └── bin/node               # 托管运行时；daemon 与各 hook 的 fallback 首位
```

Windows 兼容两种产物布局：`bin\node.exe` 与官方 zip 的根目录 `node.exe`（优先前者）。

运行期自愈：`node-bin` 指向的路径失效时，collector 的自愈逻辑会优先重指 `runtime/` 下的托管 node（永不被 node 版本管理器删除）；各 hook 脚本的只读 fallback 也把托管 runtime 路径放在第一位。

环境变量覆盖（调试/内网镜像用）：

| 变量 | 说明 |
|------|------|
| `LOONGSUITE_PILOT_NODE_VERSION` | 托管 node 版本，默认 `22.22.2`。 |
| `LOONGSUITE_PILOT_NODE_DEPS_URL` | 托管 node 下载 base URL。 |
| `LOONGSUITE_PILOT_NODE_MODULES_URL` | 预编译 node_modules 下载 base URL。 |

诊断提示：安装日志出现 `下载托管 Node.js` / `Downloading managed Node.js` 即走托管路径；出现 `回退系统 node` / `falling back to system node` 说明托管下载失败或平台不受支持，随后会使用系统 node；`sha256 mismatch` 表示产物校验失败，已中止落盘并回退。

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

本地 Dashboard 会随采集服务一起启动和停止，直接打开：

```text
http://127.0.0.1:8765/
```

页面直接读取 `logs/metrics-summary.json`，不会另起一套聚合计算。

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
安装命令只使用 Pilot 已有的 Node 和 macOS 自带工具。

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
npm install
npm run build
node scripts/postinstall.js
node dist/index.js
```

这会以前台方式启动 collector。启动时，Pilot 会读取 `agents.d/` 中的 Agent 定义，自动检测已安装 Agent，并为检测到的 Agent 部署采集能力。

## 将本地构建安装为服务

```bash
bash deploy/package-opensource.sh
bash deploy/installer-opensource.sh --package-url "file://$(pwd)/loongsuite-pilot.tar.gz"
```

## 下一步

- 在 [Agent 配置](agents.md) 选择 Agent。
- 在 [本地 JSONL 输出](local-jsonl-output.md) 验证本地输出。
- 在 [SLS 输出](sls-output.md) 配置 SLS 上报。
- 在 [Trace 输出](trace-output.md) 配置 Trace 上报。
- 在 [数据脱敏](masking.md) 配置密钥脱敏。
