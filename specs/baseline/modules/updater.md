# Module: updater

> Last verified: 2026-05-13

## 职责 (Responsibility)

自动更新层，负责定期检查远端版本清单、下载新版本、校验完整性、部署更新并重启相关服务。

## 公共接口 (Public Interface)

- **Updater** — 自动更新核心类，负责定时检查远端版本清单、判断是否需要更新、执行下载部署与服务重启。支持指数退避重试和自动停止。
- **VersionManifest / LocalVersion** — 版本信息接口，分别描述远端清单和本地版本的结构（版本号、git commit、下载地址、SHA-256 等）。
- **UpdaterPaths** — 更新器路径配置接口，定义 cache、versions、pointer files、bootstrap 等目录布局。
- **version-utils** — 版本比较和 SHA-256 校验工具函数。
- **index.ts (Updater Entry Point)** — 独立进程入口，读取配置后创建 Updater 实例并启动定时检查循环。

## 内部设计 (Internal Design)

### 更新检查流程
```
start() → 延迟 60s 首次 check → setInterval 周期 check
```

每次 `check()`:
1. Fetch remote `latest.json` manifest（30s timeout）
2. 读取本地 VERSION 文件获取 LocalVersion
3. `needsUpdate()` 比较版本号（semver）和 git_commit
4. 若需更新 → `downloadAndDeploy()` → `restartCollector()` → `restartMonitorIfRunning()` → `gcOldVersions()`

### 版本比较逻辑
- semver 数值比较（major.minor.patch）
- 同版本号时比较 git_commit（rebuild 检测）
- 远端版本低于本地时跳过（降级保护）

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
- `restartCollector()`：调用 `loongsuite-pilot restart-collector`
- `restartMonitorIfRunning()`：检查 PID 文件判断是否运行中，是则 stop + start

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AutoUpdateConfig` |
| core | `buildAutoUpdateConfig` (from config-loader) |
| utils | `createLogger`, `initFileLogging`, `readJsonFile`, `resolveHome` |
| node:fs/promises | 文件系统操作 |
| node:child_process | `execFile` (tar, npm, loongsuite-pilot) |
| node:crypto | SHA-256 校验 |
| node:stream | Download stream pipeline |

## 约束 (Constraints)

1. **独立进程运行**：updater 作为 `updater-daemon.js` 独立于 collector 进程。
2. **原子部署**：通过 pointer files + 临时目录确保部署要么完全成功要么回滚。
3. **SHA-256 校验不可跳过（当 manifest 提供时）**：mismatch 必须中止更新。
4. **不允许降级**：远端版本低于本地时静默跳过。
5. **npm install 使用 `--production`**：不安装 devDependencies。
6. **maxBackoff 6 小时**：避免长时间停止检查。
7. **restartCollector 失败仅 warn 不 throw**：更新已完成，下次进程重启自动使用新版本。
8. **GC 始终保留 current + previous**：确保有回滚能力。
