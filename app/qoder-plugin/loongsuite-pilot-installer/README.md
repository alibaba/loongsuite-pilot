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

1. **幂等检查** — CLI 入口已存在则立即退出（mac/Linux `~/.local/bin/loongsuite-pilot`；Windows `%USERPROFILE%\.local\bin\loongsuite-pilot.cmd`）
2. **并发锁** — 多会话同时启动时只有一个实例执行安装
3. **Node 运行时** — 本机已有 node ≥ 22 则复用；否则按平台从 OSS 下载 Node v22.22.2 并解包到插件数据目录（不依赖 nvm、不写用户 shell 配置）
4. **安装 pilot** — 下载对应平台的 installer 并透传管理员配置的参数

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

维护者刷新/换版本时，先拉取产物（含 sha256 校验，输出到 `vendor/node/`）：

```bash
./scripts/package-node-dists.sh             # 默认 22.22.2
./scripts/package-node-dists.sh 22.22.2     # 显式指定版本
```

然后上传到 `NODE_DIST_BASE_URL` 对应前缀（注意平铺、公读）：

```bash
ossutil cp -r -f vendor/node/ oss://taiye-test-sh/sensen-test/ --acl public-read
```

产物不入 git（约 241MB，已 gitignore），上传后本地可删。若需**离线分发**，把对应平台的包放回插件 `vendor/node/` 一同拷给用户，脚本会优先用本地包、不访问网络。

## 安装与验证

```bash
qodercli plugins install /path/to/loongsuite-pilot-installer   # 默认 user 级
# 或从市场：qodercli plugins marketplace add <市场目录/仓库> && qodercli plugins install loongsuite-pilot-installer
# 重启 CLI 或 /plugins reload，下一次会话启动即自动安装

loongsuite-pilot status                     # 验证
```

安装日志：`~/.qoder/plugins/data/loongsuite-pilot-installer-*/install.log`（Windows：`%USERPROFILE%\.qoder\plugins\data\...`）

插件本体落盘位置：`~/.qoder/plugins/cache/<市场名或 local>/loongsuite-pilot-installer/<版本>/`

> 注意：插件缓存**按版本号复用**。改了代码但版本号不变时，`plugins install` 不会刷新已有缓存；开发期验证请先 `plugins uninstall` 或递增 `version`。

## 已知限制与验证边界

- **macOS(arm64)：已端到端实测**（插件安装 → 会话触发 → pilot running → 参数落地）
- **Windows Server (NT 10.0, AMD64, PowerShell 5.1)：已端到端实测** — 插件 user 级安装 → 会话触发 → 40 秒完成安装 → `loongsuite-pilot v1.1.19 running`（Task Scheduler 自启）→ 9 个管理员参数全部落到 config.json
- **Linux x64/arm64、darwin-x64**：走完全相同的 bash 代码路径，但未在对应机器上实测
- Node 分发包目前只上传了 `win-x64`；Windows on ARM 会先试 `arm64`、失败后回退到 x64（走系统仿真）
- OSS 上的分发包需为公读（`--acl public-read`），因为 hook 用匿名下载
- 不传 `--user.id` 时 config.json 不会写入 `userId` 字段，由 pilot 运行时回退到 hostname

### Windows 实测中发现并修复的问题

以下三个 bug 只在真实 Windows 上才暴露，已全部修复并重验：

| 问题 | 表现 | 修复 |
|------|------|------|
| ps1 无 BOM | PS 5.1 按 ANSI 读带中文注释的脚本，报 `UnexpectedToken` 直接无法解析 | ps1 文件写入 UTF-8 BOM |
| conf 读取编码 | `Get-Content -Raw` 按 ANSI/GBK 读无 BOM 的 conf，中文注释吞掉后续字节，`INSTALL_ARGS` 解成空（参数全丢） | 改用 `[IO.File]::ReadAllText($conf, UTF8)` |
| 残留锁 | CLI 退出杀掉 async hook 进程，锁目录残留，后续所有会话永久跳过安装 | 锁加 15 分钟 TTL，过期自动接管（sh/ps1 均同步） |

## 本地自测

```bash
# bash 侧：仅准备 node（不装 pilot）
./scripts/ensure-pilot.sh --provision-node-only

# PowerShell 侧：配置解析 + 参数映射单测（任意平台可跑）
pwsh -NoProfile -File tests/test-config-parsing.ps1
```
