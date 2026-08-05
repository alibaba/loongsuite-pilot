# loongsuite-pilot-installer 维护者文档

面向插件维护者：内部实现机制、Node 分发打包、插件 zip 打包、平台验证边界与排障记录。
用户用法见 [../loongsuite-pilot-installer/README.md](../loongsuite-pilot-installer/README.md)。

本目录脚本均为**维护者工具，不随插件分发**。下列命令默认在本目录（`app/qoder-plugin/tools/`）执行。

## 内部实现机制

`SessionStart`（`matcher: startup`、`async: true`）hook 按平台分两条注册：

| 平台 | `shell` | 脚本 | 安装器 |
|------|---------|------|--------|
| macOS / Linux | `bash` | [../loongsuite-pilot-installer/scripts/ensure-pilot.sh](../loongsuite-pilot-installer/scripts/ensure-pilot.sh) | `installer.sh`（kebab-case 参数） |
| Windows | `powershell` | [../loongsuite-pilot-installer/scripts/ensure-pilot.ps1](../loongsuite-pilot-installer/scripts/ensure-pilot.ps1) | `installer.ps1`（PascalCase 参数） |

两条每次会话都会尝试执行，非本平台的那条因找不到 shell 而失败退出（仅写一行 CLI 日志，**不会向对话注入任何内容**）。Windows 上若 bash 脚本被 Git Bash 拉起，会自行静默退出让位给 PowerShell hook。

两个脚本逻辑等价：

1. **三信号幂等闸门** — 每次会话启动触发，命中即毫秒级退出：
   - 已安装（mac/Linux `~/.local/bin/loongsuite-pilot`；Windows `%USERPROFILE%\.local\bin\loongsuite-pilot.cmd`）+ 参数指纹未变 + 进程存活（读 `~/.loongsuite-pilot/loongsuite-pilot.pid` 判活）→ 直接跳过
   - 已安装 + 指纹未变但进程已死 → 直接 `start` 复活（秒级，不重装）
   - 未安装 / 指纹不一致 → 进入安装流程（见下条 detach）
2. **异步 detach** — 需要安装/重装时，hook 只做上面的判定就立即返回、并向对话注入“正在后台安装”提示；真正的重活扔进一个脱离 CLI 进程树的后台进程执行，既不阻塞会话、也不随 CLI 退出被腰斩（mac/Linux：`setsid`/`nohup` + `</dev/null`；Windows：`Start-Process -WindowStyle Hidden`。uid 经环境变量传给后台进程，因其已无 stdin payload）
3. **并发锁** — 多会话同时启动时只有一个后台进程执行安装（node 下载也在锁内，不会重复下载）
4. **Node 运行时** — 本机已有 node ≥ 22 则复用；否则按平台从 OSS 下载 Node v22.22.2 并解包到插件数据目录（不依赖 nvm、不写用户 shell 配置）
5. **安装 / 重装 pilot** — 未安装则直接安装；指纹不一致则重新 `install` 覆盖（installer 对 config.json 是 merge 语义、自身会停旧进程并重启，**不再 `uninstall --purge`**，保留本地数据）。mac/Linux/Windows 一致，均直接 `install` 覆盖，不做预停机——Windows 上 installer 的 `install` 会自行停旧进程并覆盖被运行中 node.exe / wscript 启动器占用的文件（已实测）

### 参数指纹

`installer` 对 `config.json` 是**合并语义**（未传的参数保留旧值），直接重跑 install 会残留旧配置。因此插件用**参数指纹**（`INSTALLER_URL` + `INSTALL_ARGS` 的 sha256，存于 `<QODER_PLUGIN_DATA>/install-args.sha256`）判定变更，不一致则重新 install 覆盖。

## Node 分发包

默认从 OSS 在线下载，**仓库与插件都不携带任何 node 二进制**。当前源：

```
https://taiye-test-sh.oss-cn-shanghai.aliyuncs.com/sensen-test/node-v22.22.2-<platform>.tar.gz
```

已上传的平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win-x64`（均为公读）。

刷新 / 换版本时，先拉取产物（含 sha256 校验，输出到插件的 `vendor/node/`）：

```bash
./package-node-dists.sh             # 默认 22.22.2
./package-node-dists.sh 22.22.2     # 显式指定版本
```

再上传到 `NODE_DIST_BASE_URL` 对应前缀（注意平铺、公读）：

```bash
ossutil cp -r -f ../loongsuite-pilot-installer/vendor/node/ oss://taiye-test-sh/sensen-test/ --acl public-read
```

产物不入 git（约 241MB），上传后本地可删。若需**离线分发**，把对应平台的包放回插件 `vendor/node/` 一同拷给用户，脚本会优先用本地包、不访问网络。

## 插件打包（zip）

把插件打成可分发 zip，产物默认输出到 `app/qoder-plugin/dist/`（不入 git）：

```bash
./package-plugin-zip.sh              # 只打本体（推荐，node 联网下载）
./package-plugin-zip.sh --with-node  # 连 vendor/node/ 一起打（离线分发）
./package-plugin-zip.sh -o /tmp      # 指定输出目录
```

- zip 名取自 `.qoder-plugin/plugin.json` 的 name+version（如 `loongsuite-pilot-installer-0.3.0.zip`）
- 默认排除 `vendor/node/` 与运行期落盘文件（`install.log`、`install.lock`、`install-args.sha256` 等）
- zip 顶层含两个目录：真实插件 `loongsuite-pilot-installer/`，以及打包时**现场生成**的占位空插件 `__empty__/`（仅含 `.qoder-plugin/plugin.json`，不入仓）

## 平台验证边界

- **macOS(arm64)：已端到端实测**（插件安装 → 会话触发 → pilot running → 参数落地）
- **Windows Server (NT 10.0, AMD64, PowerShell 5.1)：已端到端实测** — 插件 user 级安装 → 会话触发 → 40 秒完成安装 → `loongsuite-pilot v1.1.19 running`（Task Scheduler 自启）→ 9 个管理员参数全部落到 config.json
  - **重装覆盖已实测**：对正在运行的 pilot 直接 `install`（不做任何预停机）49 秒完成、退出码 0、pilot 重启后 running——installer 的 `install` 自身会停旧进程并覆盖被占用文件，故已**移除 `Stop-PilotHard`**，与 bash 侧逻辑对齐
- **Windows 受限语言模式（ConstrainedLanguage）：已实测**——在真实 Windows 上把 runspace 降级为 `ConstrainedLanguage` 后，`-ProvisionNodeOnly`（conf 解析 + `$input` + node 探测）、`-RunInstall`（滚动哈希指纹 + installer 重装 → pilot running）、默认 hook 快路径（指纹命中秒退）三条路径均通过；`tar.exe` 解真实 node.zip、`Invoke-WebRequest` 下载均确认可用
  - ⚠️ 手动 `$ExecutionContext.SessionState.LanguageMode` 降级**比真实 WDAC/AppLocker 更严格**：真实锁定策略下微软签名的内置模块以 FullLanguage 受信运行，`Get-FileHash`/`Expand-Archive` 反而可用。脚本按最严格口径改写（外部程序 + 纯 PS），故 WDAC / AppLocker / 手动降级三种来源全覆盖
- **Linux x64/arm64、darwin-x64**：走完全相同的 bash 代码路径，但未在对应机器上实测
- Node 分发包目前只上传了 `win-x64`；Windows on ARM 会先试 `arm64`、失败后回退到 x64（走系统仿真）
- OSS 上的分发包需为公读（`--acl public-read`），因为 hook 用匿名下载

## Windows 实测中发现并修复的问题

以下问题只在真实 Windows 上才暴露，已全部修复并重验：

| 问题 | 表现 | 修复 |
|------|------|------|
| ps1 无 BOM | PS 5.1 按 ANSI 读带中文注释的脚本，报 `UnexpectedToken` 直接无法解析 | ps1 文件写入 UTF-8 BOM |
| conf 读取编码 | `Get-Content -Raw` 按 ANSI/GBK 读无 BOM 的 conf，中文注释吞掉后续字节，`INSTALL_ARGS` 解成空（参数全丢） | 改用 `[IO.File]::ReadAllText($conf, UTF8)` |
| 残留锁 | CLI 退出杀掉 async hook 进程，锁目录残留，后续所有会话永久跳过安装 | 锁加 15 分钟 TTL，过期自动接管（sh/ps1 均同步）。注：安装已改为 detach 独立进程，不再随 CLI 退出被杀，进一步降低残留概率 |
| 子进程输出进管道会挂死 | `installer \| Add-Content` 等 stdout 句柄关闭，而 installer 启动的守护进程继承了句柄 → hook 永久阶段 | 改用文件重定向 `*>> $LogFile`，不用管道 |
| EAP=Stop + 子进程 stderr | 子进程的错误流经 `*>&1` 合并后变成我们的终止性错误，重装直接中断 | 子进程调用前局部设 `ErrorActionPreference='Continue'` |
| 重装覆盖运行中的 pilot | 曾担心 wscript 启动器/计划任务持有 `~/.loongsuite-pilot` 内文件导致 `install` 覆盖失败 | 实测证伪：对运行中的 pilot 直接 `install`（不做任何预停机）即可覆盖成功（退出码 0、pilot 重启后 running）——installer 的 `install` 自身会停旧进程并覆盖被占用文件。故与 bash 侧对齐，**移除 `Stop-PilotHard`**，不做预停机/杀进程/删计划任务，也**不 `uninstall --purge`**，本地数据保留 |
| 受限语言模式（CLM）下无法运行 | AppLocker/WDAC 环境把 PS 置于 ConstrainedLanguage，禁止非核心 .NET 类型的静态方法/构造。脚本原有的 `[System.IO.File]`/`[regex]`/`[System.Security.Cryptography.SHA256]`/`[System.Text.Encoding]`/`[Console]` 直接失败；`Get-FileHash`/`Expand-Archive` 这类脚本/CDXML 模块 cmdlet 在最严格的 CLM 下也不可用（内部建类型 / 模块加载被禁） | 全改为 cmdlet / 语言运算符 / 外部程序：conf 读取 `Get-Content -Raw -Encoding UTF8`；`INSTALL_ARGS` 解析用 `-split`+`-match` 逐行；stdin 读取用自动变量 `$input`；指纹改为纯 PS 双滚动哈希（内存计算不落盘，避免 license key 明文落盘）；node 解包 `Expand-Archive` → `tar.exe`。仅保留 `[int]`/`[long]`/`[bool]`/`[switch]` 等核心类型强转 |

## 本地自测

```bash
# bash 侧：仅准备 node（不装 pilot）
../loongsuite-pilot-installer/scripts/ensure-pilot.sh --provision-node-only

# PowerShell 侧：仅准备 node（不装 pilot）
pwsh -NoProfile -File ../loongsuite-pilot-installer/scripts/ensure-pilot.ps1 -ProvisionNodeOnly
```
