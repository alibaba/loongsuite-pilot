# Module: updater

> Last verified: 2026-06-08

## 职责 (Responsibility)

自动更新层，负责定期检查远端版本清单、下载新版本、校验完整性、部署更新并重启相关服务。

## 公共接口 (Public Interface)

- **Updater** — 自动更新核心类，负责定时检查远端版本清单、判断是否需要更新、执行下载部署与服务重启。支持指数退避重试和自动停止。
- **VersionManifest / LocalVersion** — 版本信息接口，分别描述远端清单和本地版本的结构（版本号、git commit、下载地址、SHA-256 等）。
- **UpdaterPaths** — 更新器路径配置接口，定义 cache、versions、pointer files、bootstrap 等目录布局。
- **CanaryManifest / LatestManifest / ResolvedTarget** — 灰度发布相关类型。`CanaryManifest` 扩展 `VersionManifest` 增加 `rollout_percentage` 和 `hotfix_version`；`LatestManifest` 扩展 `VersionManifest` 增加可选 `canary` 字段；`ResolvedTarget` 为 `resolveTargetVersion()` 的返回值，包含 `manifest`、`channel`（stable/canary）和 `hotfixVersion`。
- **version-utils** — 版本比较、SHA-256 校验和灰度分桶工具函数。
- **index.ts (Updater Entry Point)** — 独立进程入口，读取配置后创建 Updater 实例并启动定时检查循环。

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/updater/
├── index.ts          # updater 独立进程入口
├── updater.ts        # manifest 检查、下载、部署、重启、GC
└── version-utils.ts  # semver 比较、SHA-256 校验、灰度分桶

scripts/
└── updater-daemon.js # runtime shim，按 current 指针加载 dist/updater/index.js
```

### 运行时布局 (Runtime Layout)

```
~/.loongsuite-pilot/
├── current
├── previous
├── versions/{version}_{commit}/
├── bin/updater-daemon.js
└── logs/loongsuite-pilot-updater.log
```

Updater 与 installer/CLI 共享 version pointer 协议；任何部署或回滚语义变化都需要同步检查 `runtime.md`。

### 更新检查流程
```
start() → 延迟 60s 首次 check → setInterval 周期 check
```

每次 `check()`:
1. `ensureInstallId()` — 若 config 中无 `installId`，生成 UUID v4 并写入 `config.json`
2. Fetch remote `latest.json` manifest（30s timeout）
3. `resolveTargetVersion()` — 若远端含 `canary` 字段，按优先级决策目标版本（见下方灰度决策逻辑）
4. 读取本地 VERSION 文件获取 LocalVersion
5. `needsUpdate()` 比较版本号（semver）和 git_commit，canary channel 额外比较 `hotfix_version`
6. 若需更新 → `downloadAndDeploy()` → `persistCanaryState()` → `restartCollector()` → `restartMonitorIfRunning()` → `gcOldVersions()`

### 灰度决策逻辑 (resolveTargetVersion)

当远端 `latest.json` 含 `canary` 字段时，`resolveTargetVersion()` 按以下优先级决定客户端走 stable 还是 canary：
1. `canary.policy = 'off'` → 强制 stable
2. `canary.policy = 'latest'` → 强制 canary
3. `canary.policy = 'auto'`（默认）→ `deterministicBucket(installId, canaryVersion) < rollout_percentage` → canary，否则 stable

整个函数用 try/catch 包裹，异常时 fallback 到 stable，确保灰度逻辑不影响现有更新路径。

### installId 管理
- 首次 `check()` 时自动生成 UUID v4，写入 `~/.loongsuite-pilot/config.json` 的 `installId` 字段
- 后续 check 使用已有值，保证同一机器在同一灰度版本下始终落入同一 bucket

### 灰度分桶 (deterministicBucket)
`bucket = SHA256(installId + canaryVersion).readUInt32BE(0) % 100`，返回 `[0, 99]` 范围内的整数。混入 canary version 意味着不同灰度版本会命中不同的机器集合，避免同一批机器始终充当灰度先锋；同一灰度版本的渐进放量仍然是单调的（version 不变则 bucket 不变）。hotfix 不改 version，因此同一批用户会收到修复。

### hotfix_version 比较
当 channel 为 canary 且 semver 版本号相同时，`needsUpdate()` 额外比较远端 `canary.hotfix_version` 与本地 `config.canaryHotfixVersion`。远端更大时触发更新，实现不改版本号的 canary 迭代修复。

### 灰度状态持久化 (persistCanaryState)
canary 更新成功后，将远端 `hotfix_version`（默认 0）写入 `config.json` 的 `canary.hotfix_version` 字段，用于下次 hotfix 比较。

### 版本比较逻辑
- semver 数值比较（major.minor.patch）
- 同版本号时比较 git_commit（rebuild 检测）
- 远端版本低于本地时跳过（降级保护）
- canary channel 额外比较 hotfix_version

### 下载与部署
1. 创建临时目录 `download-tmp/`
2. Stream 下载 tarball（5min timeout）
3. SHA-256 校验（manifest 提供时）
4. `tar -xzf` 解压
5. 查找含 `package.json` 的目录
6. 验证 `dist/index.js` 存在
7. 复制到 `versions/{version}_{commit}/`
8. `npm install --production --no-optional`
9. 执行 `postinstall.js`
10. 更新 pointer files（current/previous）
11. 同步 bootstrap scripts

### Pointer Files 系统
- `~/.loongsuite-pilot/current` → 当前版本目录名
- `~/.loongsuite-pilot/previous` → 上一版本目录名（回滚用）

部署时先备份 current 到 previous，再写入新的 current。失败时自动恢复 pointers。

### 指数退避重试
- 失败后 backoff = `checkIntervalMs × 2^consecutiveFailures`
- 最大退避 6 小时
- 连续失败 10 次后停止 updater

### 版本 GC
保留 current 和 previous 两个版本目录，其余旧版本自动删除。

### 服务重启
- `restartCollector()`：调用 `loongsuite-pilot restart-collector`，该命令内部在重启 collector 后会在**独立进程组**中调度 `loongsuite-pilot restart-updater`（通过 `setsid` 或 `perl POSIX::setsid`），使 updater 加载新版本代码。进程组隔离确保 `launchctl stop` / `systemctl stop` 不会误杀调度进程。
- `restartMonitorIfRunning()`：检查 PID 文件判断是否运行中，是则 stop + start

### 服务配置（进程隔离）
- macOS launchd plist：设置 `AbandonProcessGroup = true`，使 `launchctl stop` 仅终止主进程而非整个进程组。
- Linux systemd unit：设置 `KillMode=process`，效果等同——仅杀主 PID 而非整个 cgroup。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AutoUpdateConfig` (含 `installId`, `canaryPolicy`, `canaryHotfixVersion`) |
| core | `buildAutoUpdateConfig` (from config-loader) |
| utils | `createLogger`, `initFileLogging`, `readJsonFile`, `writeJsonFile`, `resolveHome` |
| node:fs/promises | 文件系统操作 |
| node:child_process | `execFile` (tar, npm, loongsuite-pilot) |
| node:crypto | SHA-256 校验 |
| node:stream | Download stream pipeline |

## 约束 (Constraints)

1. **独立进程运行**：updater 作为 `updater-daemon.js` 独立于 collector 进程。
2. **原子部署**：通过 pointer files + 临时目录确保部署要么完全成功要么回滚。
3. **SHA-256 校验不可跳过（当 manifest 提供时）**：mismatch 必须中止更新。
4. **不允许降级**：远端版本低于本地时静默跳过（forward-only）。
9. **灰度逻辑 try/catch 包裹**：`resolveTargetVersion()` 任何异常 fallback 到 stable，不影响现有更新路径。
10. **installId 只生成一次**：已有 installId 不覆盖，保证 bucket 稳定性。
5. **npm install 使用 `--production`**：不安装 devDependencies。
6. **maxBackoff 6 小时**：避免长时间停止检查。
7. **restartCollector 失败仅 warn 不 throw**：更新已完成，下次进程重启自动使用新版本。
8. **GC 始终保留 current + previous**：确保有回滚能力。
