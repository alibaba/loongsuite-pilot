# Module: runtime

> Last verified: 2026-05-13

## 职责 (Responsibility)

安装与运行时外壳层，负责把构建产物部署到用户机器、维护版本指针、安装 CLI bootstrap、注册后台服务，并在进程启动时解析到当前可运行版本。

本模块覆盖 collector / updater 的进程外生命周期；collector 内部业务编排由 `core.md` 负责，自动更新检查与下载部署细节由 `updater.md` 负责。

## 公共接口 (Public Interface)

- **Installer** (`deploy/installer.sh` / `deploy/installer-inner.sh`) — 用户安装、升级、卸载入口，负责下载安装包、部署版本目录、写入配置、安装命令、部署 hooks/skills、安装 OTel plugin，并启动服务。外部版本使用 `installer.sh`（路径 `loongsuite-pilot/`），内部版本使用 `installer-inner.sh`（路径 `loongsuite/loongsuite-pilot/`）。
- **CLI bootstrap** (`scripts/loongsuite-pilot.sh`) — 用户侧服务管理命令，提供 `start` / `stop` / `restart` / `status` / `info` / `rollback` / `monitor` / `run` / `run-updater` 等命令。
- **Collector daemon shim** (`scripts/collector-daemon.js`) — 根据 `current` / `previous` 指针加载当前 collector 版本的 `dist/index.js`。
- **Updater daemon shim** (`scripts/updater-daemon.js`) — 根据 `current` 指针加载当前版本的 `dist/updater/index.js`。
- **Postinstall** (`scripts/postinstall.js`) — 将 `assets/hooks/` 和 `assets/skills/` 部署到 `~/.loongsuite-pilot/`，并设置脚本权限。
- **Autostart templates** (`scripts/loongsuite-pilot.sh`, `deploy/autostart.sh`) — 为 macOS launchd、Linux systemd user/system、init.d 生成服务配置。

## 内部设计 (Internal Design)

### 运行时目录布局

```
~/.loongsuite-pilot/
├── current                         # 当前版本目录名
├── previous                        # 上一版本目录名，用于 rollback
├── versions/{version}_{commit}/    # 不可变版本目录
├── bin/
│   ├── collector-daemon.js         # bootstrap shim
│   └── updater-daemon.js           # bootstrap shim
├── config.json
├── hooks/
├── skills/
└── logs/
```

### 安装流程

1. 校验安装用户和依赖（node/npm/curl 或 wget/tar）。
2. 如存在旧单目录布局，迁移到 `versions/{version}_{commit}`。
3. 下载并解压安装包，定位包含 `package.json` 的目录。
4. 部署版本目录，更新 `current` / `previous` 指针。
5. 同步 bootstrap scripts 到 `~/.loongsuite-pilot/bin/`。
6. 执行 `npm install --production --no-optional`。
7. 执行 `scripts/postinstall.js` 部署 hooks/skills。
8. 写入或合并 `config.json`。
9. 安装 `~/.local/bin/loongsuite-pilot` 管理命令。
10. best-effort 安装 OTel plugin 并启动后台服务。

### CLI 启动模型

`loongsuite-pilot start` 优先注册系统服务：

- macOS: launchd user LaunchAgent
- Linux: systemd user service
- Linux with `--system-service` or root: systemd system service
- legacy Linux fallback: init.d
- 无可用 service manager 时：nohup fallback

服务实际执行 `loongsuite-pilot run`，由 CLI 设置 `AGENT_DATA_COLLECTION_CONFIG` 后通过 `collector-daemon.js` 加载当前版本 collector。Updater 使用同样模式执行 `loongsuite-pilot run-updater`。

### 版本指针与回滚

- `current` 指向当前版本目录。
- `previous` 指向上一版本目录。
- collector shim 优先加载 `current`，失败时可回退读取 `previous`。
- `loongsuite-pilot rollback` 交换 `current` / `previous`，同步 CLI/bootstrap scripts，并重启服务。

### 与 updater 的关系

Installer 和 CLI 负责本地运行时结构与服务管理；`updater.md` 负责远端 manifest 检查、下载安装、校验、部署新版本和触发 `restart-collector`。两者共享 `versions/`、`current`、`previous` 这套版本指针协议。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| core | collector 进程最终加载 `dist/index.js` 并启动 Orchestrator |
| hooks | postinstall 部署 hook 脚本；Orchestrator 启动时注入 hook 配置 |
| updater | updater daemon 与 CLI `restart-collector` / version pointers 协作 |
| monitor | CLI `monitor start/stop` 管理可选监控进程 |
| deploy | installer、package、upload、autostart shell scripts |

## 扩展指南 (Extension Guide)

### 修改安装或服务生命周期

涉及安装、升级、卸载、服务注册、版本目录、bootstrap shim 或 CLI service command 的变更，应先阅读本模块，并同时检查：

- `deploy/installer.sh` / `deploy/installer-inner.sh`
- `scripts/loongsuite-pilot.sh`
- `scripts/collector-daemon.js`
- `scripts/updater-daemon.js`
- `scripts/postinstall.js`

### 添加新的部署产物

1. 确认产物是否必须进入发布包（`package.json` `files`、`deploy/package.sh`）。
2. 如需安装到用户数据目录，在 `scripts/postinstall.js` 中部署。
3. 如运行时 CLI 需要访问，确保 `scripts/loongsuite-pilot.sh` 能从当前版本目录或 bootstrap 目录解析到它。
4. 如果影响升级/回滚，必须保持 `current` / `previous` 指针协议可恢复。

## 状态栏 App 运行时管理

### runtime.json 规范

Collector daemon 启动后在 `{dataDir}/logs/runtime.json` 写入运行时状态：

```json
{ "status": "active", "packageVersion": "1.1.3", "pid": 14491, "updatedAt": "ISO" }
```

- 30s 刷新 `updatedAt`（证明进程活着）
- daemon stop 时删除文件
- 原子写入（write-tmp + rename）

### StatusBarAppManager

管理 Swift binary 进程生命周期（仅 macOS）：
- 优先使用预编译 binary: `{versionDir}/app/macos-status-bar/bin/darwin-{arch}/LoongSuitePilotMenuBarApp`
- Fallback: 使用 `swiftc` 直接编译 Swift 源文件（绕过 SPM，不依赖 `Package.swift` 解析）
- 编译产出路径: `{dataDir}/apps/macos-status-bar/build/LoongSuitePilotMenuBarApp`
- 运行时记录: `{dataDir}/logs/status-bar-app-runtime.json`
- 配置开关: `enableStatusBarApp` (config.json) / `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP` (env)

### 构建策略

**打包时构建** (`scripts/build-status-bar-app.mjs`)：
- 使用 `swiftc` 直接编译，产出预编译 binary 到 `app/macos-status-bar/bin/darwin-{arch}/`
- 集成到 `build.mjs`（best-effort，编译失败不阻塞主构建）
- `deploy/package.sh` 将 `app/macos-status-bar/` 含预编译 binary 打入 tarball

**运行时 fallback 构建** (`StatusBarAppManager.buildExecutable()`)：
- 当预编译 binary 不存在时（如 arm64 包安装到 x64 Mac），自动尝试本地编译
- 使用 `swiftc` 直接编译（与打包脚本一致），不走 SPM（避免 `Package.swift` 解析因 CLT 版本不匹配而失败）
- 异步执行，不阻塞 daemon 事件循环
- 编译失败只 log warning，不影响 daemon 采集功能

## 约束 (Constraints)

1. **版本目录视为不可变**：部署后不得原地修改业务代码；升级通过新目录 + pointer 切换完成。
2. **pointer 写入必须原子化**：更新 `current` / `previous` 使用临时文件 + `mv`，避免崩溃后半写入。
3. **bootstrap scripts 必须可跨版本加载**：`collector-daemon.js` / `updater-daemon.js` 不应依赖当前工作目录。
4. **postinstall 不得阻断安装**：hooks/skills 部署失败应告警并继续，不能导致 npm install 整体失败。
5. **服务命令必须设置 `AGENT_DATA_COLLECTION_CONFIG`**：后台进程必须读取安装目录下的 `config.json`。
6. **停止服务必须同时清理 PID 文件和 service manager 状态**：避免下一次启动误判。
7. **卸载必须清理注入配置**：移除 agent settings 中含 `.loongsuite-pilot` 标记的 hook entry。
8. **monitor 是可选运行时**：`start` 启动 collector/updater，不应隐式启动 monitor；`stop` 可顺带停止 monitor。
