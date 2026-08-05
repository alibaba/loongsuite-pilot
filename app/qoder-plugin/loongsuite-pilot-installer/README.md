# loongsuite-pilot-installer

Qoder CLI 插件：安装并启用后，在下一次会话启动时自动检测并安装 `loongsuite-pilot`。

## 工作机制

`SessionStart`（`matcher: startup`、`async: true`）hook 按平台分两条注册：

| 平台 | `shell` | 脚本 | 安装器 |
|------|---------|------|--------|
| macOS / Linux | `bash` | [scripts/ensure-pilot.sh](scripts/ensure-pilot.sh) | `installer.sh`（kebab-case 参数） |
| Windows | `powershell` | [scripts/ensure-pilot.ps1](scripts/ensure-pilot.ps1) | `installer.ps1`（PascalCase 参数） |

两条每次会话都会尝试执行，非本平台的那条因找不到 shell 而失败退出（已实测：仅写一行 CLI 日志，**不会向对话注入任何内容**）。Windows 上若 bash 脚本被 Git Bash 拉起，会自行静默退出让位给 PowerShell hook。

两个脚本逻辑等价：

1. **三信号幂等闸门** — 每次会话启动触发，命中即毫秒级退出：
   - 已安装（mac/Linux `~/.local/bin/loongsuite-pilot`；Windows `%USERPROFILE%\.local\bin\loongsuite-pilot.cmd`）+ 参数指纹未变 + 进程存活（读 `~/.loongsuite-pilot/loongsuite-pilot.pid` 判活）→ 直接跳过
   - 已安装 + 指纹未变但进程已死 → 直接 `start` 复活（秒级，不重装）
   - 未安装 / 指纹不一致 → 进入安装流程（见下条 detach）
2. **异步 detach** — 需要安装/重装时，hook 只做上面的判定就立即返回、并向对话注入“正在后台安装”提示；真正的重活扔进一个脱离 CLI 进程树的后台进程执行，既不阻塞会话、也不随 CLI 退出被腰斩（mac/Linux：`setsid`/`nohup` + `</dev/null`；Windows：`Start-Process -WindowStyle Hidden`。uid 经环境变量传给后台进程，因其已无 stdin payload）
3. **并发锁** — 多会话同时启动时只有一个后台进程执行安装（node 下载也在锁内，不会重复下载）
4. **Node 运行时** — 本机已有 node ≥ 22 则复用；否则按平台从 OSS 下载 Node v22.22.2 并解包到插件数据目录（不依赖 nvm、不写用户 shell 配置）
5. **安装 / 重装 pilot** — 未安装则直接安装；指纹不一致则重新 `install` 覆盖（installer 对 config.json 是 merge 语义、自身会停旧进程并重启，**不再 `uninstall --purge`**，保留本地数据；Windows 侧安装前先 `Stop-PilotHard` 确保被占用文件可覆盖）

## 管理员批量更新配置

`installer` 对 `config.json` 是**合并语义**（未传的参数保留旧值），直接重跑 install 会残留旧配置。因此插件用**参数指纹**（`INSTALLER_URL` + `INSTALL_ARGS` 的 sha256，存于 `<QODER_PLUGIN_DATA>/install-args.sha256`）判定变更，不一致则重新 install 覆盖。

批量更新流程：

```
① 修改 config/install-params.conf
② 递增 .qoder-plugin/plugin.json 的 version   ← 必需！缓存按版本号复用
③ 重新分发（zip），用户 plugins install
④ 用户下次会话 → 指纹不一致 → 后台重新 install 覆盖 → 写新指纹
⑤ 此后每次会话指纹命中，毫秒级静默跳过
```

> 重装采用 `install` 覆盖而非 `uninstall --purge`：installer 合并写 config.json，管理员下发的参数会覆盖同名旧值，本地日志与采集 offset 得以保留。若确需清空本地数据，请手动执行 `loongsuite-pilot uninstall --purge`。

> 首次安装插件时若本机已有手动安装的 pilot（无指纹记录），会被当作“参数不一致”而重新 install 覆盖 —— 这是有意设计，确保最终配置以管理员下发为准。

## 管理员配置

编辑 [config/install-params.conf](config/install-params.conf)（bash 语法，bash hook 直接 source；PowerShell hook 解析同一份文件并自动把 `--collect-log` 这类 kebab-case 转成 `-CollectLog`）：

| 配置项 | 说明 |
|--------|------|
| `INSTALLER_URL` | loongsuite-pilot 安装脚本地址（`.sh`）；Windows 固定用同目录的 `installer.ps1`，除非这里显式填 `.ps1` 地址 |
| `NODE_VERSION` | Node 版本，默认 `22.22.2` |
| `NODE_DIST_BASE_URL` | Node 分发包下载源（默认 OSS），分发包平铺在该前缀下：`<base>/node-v<ver>-<platform>.tar.gz` |
| `INSTALL_ARGS` | 透传给 `installer.sh install` 的参数数组，按 `--参数名 "值"` 成对填写，新增参数无需改脚本 |

运行期环境变量可覆盖（优先级最高）：`LOONGSUITE_PILOT_INSTALLER_URL`、`LOONGSUITE_PILOT_NODE_DIST_BASE_URL`、`LOONGSUITE_PILOT_USER_ID`。

## Node 分发包

默认从 OSS 在线下载，**仓库与插件都不携带任何 node 二进制**。当前源：

```
https://taiye-test-sh.oss-cn-shanghai.aliyuncs.com/sensen-test/node-v22.22.2-<platform>.tar.gz
```

已上传的平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win-x64`（均为公读）。

维护者刷新/换版本时，先拉取产物（含 sha256 校验，输出到本插件的 `vendor/node/`）。
打包脚本是维护者工具、不随插件分发，位于同级的 `app/qoder-plugin/tools/`（在插件根目录执行）：

```bash
../tools/package-node-dists.sh             # 默认 22.22.2
../tools/package-node-dists.sh 22.22.2     # 显式指定版本
```

然后上传到 `NODE_DIST_BASE_URL` 对应前缀（注意平铺、公读）：

```bash
ossutil cp -r -f vendor/node/ oss://taiye-test-sh/sensen-test/ --acl public-read
```

产物不入 git（约 241MB），上传后本地可删。若需**离线分发**，把对应平台的包放回插件 `vendor/node/` 一同拷给用户，脚本会优先用本地包、不访问网络。

## 打包分发（zip）

把插件本体打成可分发 zip（zip 内顶层是 `loongsuite-pilot-installer/`,解开即可 `plugins install`）。脚本在同级 `app/qoder-plugin/tools/`,产物默认输出到 `app/qoder-plugin/dist/`(不入 git):

```bash
../tools/package-plugin-zip.sh              # 只打本体(推荐,node 联网下载)
../tools/package-plugin-zip.sh --with-node  # 连 vendor/node/ 一起打(离线分发)
../tools/package-plugin-zip.sh -o /tmp      # 指定输出目录
```

zip 名取自 `.qoder-plugin/plugin.json` 的 name+version(如 `loongsuite-pilot-installer-0.3.0.zip`);默认排除 `vendor/node/` 与运行期落盘文件(`install.log`/`install.lock`/`install-args.sha256` 等)。

## 安装与验证

```bash
qodercli plugins install /path/to/loongsuite-pilot-installer   # 默认 user 级
# 重启 CLI 或 /plugins reload，下一次会话启动即自动安装

loongsuite-pilot status                     # 验证
```

安装日志：`~/.qoder/plugins/data/loongsuite-pilot-installer-*/install.log`（Windows：`%USERPROFILE%\.qoder\plugins\data\...`）

插件本体落盘位置：`~/.qoder/plugins/cache/local/loongsuite-pilot-installer/<版本>/`

> 注意：插件缓存**按版本号复用**。改了代码但版本号不变时，`plugins install` 不会刷新已有缓存；开发期验证请先 `plugins uninstall` 或递增 `version`。

## 已知限制与验证边界

- **macOS(arm64)：已端到端实测**（插件安装 → 会话触发 → pilot running → 参数落地）
- **Windows Server (NT 10.0, AMD64, PowerShell 5.1)：已端到端实测** — 插件 user 级安装 → 会话触发 → 40 秒完成安装 → `loongsuite-pilot v1.1.19 running`（Task Scheduler 自启）→ 9 个管理员参数全部落到 config.json
  - ⚠️ 该实测走的是**旧的同步 + `uninstall --purge` 路径**。当前改动（三信号闸门 + `-RunInstall` detach 独立进程 + 去 `--purge` 仅保留 `Stop-PilotHard`）尚未在真实 Windows 重验，重点需验：`Start-Process -WindowStyle Hidden` detach 是否随 CLI 退出被杀、pidfile 路径是否为 `%USERPROFILE%\.loongsuite-pilot\loongsuite-pilot.pid`、指纹不一致时 `install`（不 purge）能否正确覆盖被占用文件
- **Linux x64/arm64、darwin-x64**：走完全相同的 bash 代码路径，但未在对应机器上实测
- Node 分发包目前只上传了 `win-x64`；Windows on ARM 会先试 `arm64`、失败后回退到 x64（走系统仿真）
- OSS 上的分发包需为公读（`--acl public-read`），因为 hook 用匿名下载
- 不传 `--user.id` 时 config.json 不会写入 `userId` 字段，由 pilot 运行时回退到 hostname

### Windows 实测中发现并修复的问题

以下问题只在真实 Windows 上才暴露，已全部修复并重验：

| 问题 | 表现 | 修复 |
|------|------|------|
| ps1 无 BOM | PS 5.1 按 ANSI 读带中文注释的脚本，报 `UnexpectedToken` 直接无法解析 | ps1 文件写入 UTF-8 BOM |
| conf 读取编码 | `Get-Content -Raw` 按 ANSI/GBK 读无 BOM 的 conf，中文注释吞掉后续字节，`INSTALL_ARGS` 解成空（参数全丢） | 改用 `[IO.File]::ReadAllText($conf, UTF8)` |
| 残留锁 | CLI 退出杀掉 async hook 进程，锁目录残留，后续所有会话永久跳过安装 | 锁加 15 分钟 TTL，过期自动接管（sh/ps1 均同步）。注：安装已改为 detach 独立进程，不再随 CLI 退出被杀，进一步降低残留概率 |
| 子进程输出进管道会挂死 | `installer \| Add-Content` 等 stdout 句柄关闭，而 installer 启动的守护进程继承了句柄 → hook 永久阶段 | 改用文件重定向 `*>> $LogFile`，不用管道 |
| EAP=Stop + 子进程 stderr | 子进程的错误流经 `*>&1` 合并后变成我们的终止性错误，重装直接中断 | 子进程调用前局部设 `ErrorActionPreference='Continue'` |
| 重装覆盖被占用文件 | wscript 启动器与计划任务持有 `~/.loongsuite-pilot` 内文件，`install` 覆盖时报“文件正在使用” | 指纹不一致重装前先 `Stop-PilotHard`（stop + 卸载计划任务 + 杀掉持有目录的进程），再 `install` 覆盖；**不再 `uninstall --purge` / `rmdir`**，本地数据保留 |

## 本地自测

```bash
# bash 侧：仅准备 node（不装 pilot）
./scripts/ensure-pilot.sh --provision-node-only

# PowerShell 侧：仅准备 node（不装 pilot）
pwsh -NoProfile -File scripts/ensure-pilot.ps1 -ProvisionNodeOnly
```
