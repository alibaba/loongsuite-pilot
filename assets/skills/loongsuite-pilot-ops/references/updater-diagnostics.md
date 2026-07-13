# 自动更新诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/updater-diagnostics.md`，随 pilot 升级自动更新。

覆盖 **pilot 自动更新守护进程的排查**——版本不更新、更新失败、更新后服务异常、回滚等问题。

---

## 更新机制概览

```
Updater 守护进程（独立于 collector 的进程）
    ↓ 定时轮询（默认 1 分钟）
拉取 manifest（latest.json）
    ↓ 比较本地 VERSION
需要更新时：
    下载 tarball → SHA-256 校验 → 解压 → npm install → postinstall
    → pointer swap (current/previous) → sync scripts
    → restart collector → restart monitor（如在运行）→ GC old versions
```

关键事实：
- Updater 和 Collector 是**两个独立进程**，updater 更新后会重启 collector
- 版本目录：`~/.loongsuite-pilot/versions/{version}_{commit}/`
- `current` / `previous` pointer 文件指向当前和上一个版本目录名
- 回滚 = 交换 `current` ↔ `previous` 并重启

---

## 系统化排查顺序

自动更新异常时，**按以下顺序逐步排查**：

```
第 1 步 → updater 进程是否在运行
第 2 步 → 更新配置是否正确
第 3 步 → manifest 拉取是否成功
第 4 步 → 下载与部署过程
第 5 步 → 失败退避与回滚
```

---

## 第 1 步：updater 进程是否在运行

```bash
~/.local/bin/loongsuite-pilot status
```

预期输出中 updater 显示 `running`。若 updater 未运行：

```bash
# 查看 updater 日志最后的输出
tail -30 ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log
```

常见原因：
- `auto-update disabled via config, exiting` → 更新被禁用，见第 2 步
- `updater fatal error` → 启动时发生致命错误，检查日志中的 error 字段
- `too many consecutive failures, stopping updater` → 连续失败过多（≥10 次），updater 主动停止

---

## 第 2 步：更新配置是否正确

更新配置来自 `config.json` 的 `autoUpdate` 段 + 环境变量（环境变量优先）：

```bash
# 只输出 autoUpdate 相关字段，不打印完整 config.json
python3 - <<'PY'
import json
import pathlib
path = pathlib.Path.home() / '.loongsuite-pilot' / 'config.json'
try:
    cfg = json.loads(path.read_text())
except Exception:
    print('config.json 不存在或无法解析')
    raise SystemExit(0)
auto = cfg.get('autoUpdate') or {}
for key in ('enabled', 'checkIntervalMs', 'manifestUrl', 'packageUrl'):
    print(f'{key}:', auto.get(key, '(default)'))
PY
```

| 配置项 | 环境变量 | 默认值 | 说明 |
|-------|---------|-------|------|
| `enabled` | `LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED` | `true` | 是否启用自动更新 |
| `checkIntervalMs` | `LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS` | `60000`（1 分钟） | 检查间隔 |
| `manifestUrl` | `LOONGSUITE_PILOT_MANIFEST_URL` | 自动从 `packageUrl` 推导 | manifest 地址 |
| `packageUrl` | `LOONGSUITE_PILOT_PACKAGE_URL` | 按 channel 决定 | 安装包下载地址 |

更新 channel 由 `LOONGSUITE_PILOT_CHANNEL` 环境变量决定：
- `release`（默认）→ 正式包 URL
- `test` / `pre` → 测试包 URL

```bash
# 检查 updater 日志中的实际配置
grep 'updater process running\|updater started' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log | tail -5
```

预期看到 `checkIntervalMs` 和 `manifestUrl` 的实际值。

---

## 第 3 步：manifest 拉取是否成功

Updater 定期拉取 `latest.json`（manifest），超时 30 秒。

```bash
# 手动测试 manifest 是否可达
MANIFEST_URL=$(python3 -c "
import json,sys
try:
    c=json.load(open('$HOME/.loongsuite-pilot/config.json'))
    print(c.get('autoUpdate',{}).get('manifestUrl',''))
except: pass
" 2>/dev/null)
echo "Manifest URL: $MANIFEST_URL"
curl -s --connect-timeout 10 "$MANIFEST_URL" | python3 -m json.tool
```

预期 manifest 包含：

```jsonc
{
  "version": "x.y.z",
  "git_commit": "abc1234",
  "package_url": "https://...",
  "released_at": "2026-...",
  "sha256": "..."
}
```

日志中的 manifest 相关关键字：

| 日志 | 含义 |
|------|------|
| `already up to date` | 本地版本已是最新，无需更新 |
| `new version available` | 检测到新版本，即将下载 |
| `manifest fetch failed` | HTTP 请求失败（检查网络和 URL） |
| `manifest fetch error` | 请求异常（DNS、超时等） |
| `no manifest URL configured` | manifestUrl 为空 |
| `remote version is older than local, skipping` | 远端版本反而更低（手工安装了更新的版本时会出现） |

```bash
# 查看 manifest 拉取日志
grep -E 'manifest|up to date|new version' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log | tail -10
```

---

## 第 4 步：下载与部署过程

检测到新版本后，部署流程按以下顺序执行：

| 阶段 | 日志关键字 | 超时 | 常见失败 |
|------|-----------|------|---------|
| 1. 下载 tarball | `downloading update` | 5 分钟 | 网络不通、OSS 不可达 |
| 2. SHA-256 校验 | `SHA-256 verified` / `SHA-256 mismatch` | — | 下载不完整、CDN 缓存过期 |
| 3. 解压 | `extracting update` | — | 磁盘空间不足 |
| 4. npm install | `running npm install` | 2 分钟 | npm 不可用、registry 不可达、Node.js 版本过低 |
| 5. postinstall | （静默执行） | 30 秒 | hook 注入失败（非致命，会 warn 并继续） |
| 6. pointer swap | `update deployed` | — | 文件系统权限问题 |
| 7. restart collector | `collector restarted` / `collector restart failed` | 30 秒 | 新版本 JS 代码报错 |
| 8. restart monitor | `monitor restarted` / `monitor restart failed` | 30 秒 | 仅在 monitor 运行中时执行 |
| 9. GC old versions | `removing old version` | — | 保留 current + previous 两个版本 |

```bash
# 查看最近的部署过程
grep -E 'download|SHA-256|extract|npm install|update deployed|restart|removing old' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log | tail -20
```

部署失败时，updater 会自动恢复 `current` / `previous` pointer 到之前的值：

```bash
# 查看当前和上一个版本
cat ~/.loongsuite-pilot/current
cat ~/.loongsuite-pilot/previous
```

---

## 第 5 步：失败退避与回滚

### 5.1 失败退避

每次更新失败，backoff 时间翻倍（最大 6 小时）：

```
第 1 次失败 → 等待 checkInterval × 2
第 2 次失败 → 等待 checkInterval × 4
...
第 N 次失败 → 等待 min(checkInterval × 2^N, 6h)
连续 10 次失败 → updater 停止
```

```bash
# 查看失败次数和下次重试时间
grep 'update check failed\|too many consecutive' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log | tail -10
```

若 updater 已停止（连续 10 次失败），手动重启服务即可重置计数器：

```bash
~/.local/bin/loongsuite-pilot stop
sleep 2
~/.local/bin/loongsuite-pilot start
```

### 5.2 手动回滚

更新后出现问题时，回滚到上一个版本：

```bash
~/.local/bin/loongsuite-pilot rollback
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info    # 确认回滚后的版本号
```

回滚原理：交换 `~/.loongsuite-pilot/current` ↔ `~/.loongsuite-pilot/previous` 的内容，然后重新同步 `bin/` 下的启动脚本并重启服务。

### 5.3 查看版本信息

```bash
# 当前运行的版本详情
cat ~/.loongsuite-pilot/versions/$(cat ~/.loongsuite-pilot/current)/VERSION

# 列出所有已安装的版本
ls ~/.loongsuite-pilot/versions/
```

`VERSION` 文件格式：
```
version=x.y.z
git_commit=abc1234
```

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log` | updater 守护进程日志（pino JSON，daily rotation） |
| `~/.loongsuite-pilot/config.json` | `autoUpdate` 段配置 |
| `~/.loongsuite-pilot/current` | 当前版本目录名（pointer 文件） |
| `~/.loongsuite-pilot/previous` | 上一个版本目录名（回滚用） |
| `~/.loongsuite-pilot/versions/` | 所有已安装版本的目录 |
| `~/.loongsuite-pilot/versions/{v}_{c}/VERSION` | 版本元信息（version + git_commit） |
| `~/.loongsuite-pilot/versions/{v}_{c}/dist/index.js` | 版本的 collector 入口 |
| `~/.loongsuite-pilot/bin/collector-daemon.js` | collector 启动脚本（从当前版本同步） |
| `~/.loongsuite-pilot/bin/updater-daemon.js` | updater 启动脚本（从当前版本同步） |
| `~/.local/bin/loongsuite-pilot` | CLI 入口脚本（从当前版本同步） |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| `loongsuite-pilot status` 显示 updater 未运行 | 查看 updater 日志：可能被禁用（`auto-update disabled`）、可能连续失败过多（`too many consecutive failures`）。重启服务可重置 |
| `auto-update disabled via config` | `config.json` 的 `autoUpdate.enabled` 为 `false` 或环境变量 `LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED=false`。移除禁用配置后重启 |
| manifest 拉取失败（`manifest fetch failed`） | 检查网络连通性：`curl -I <manifestUrl>`。常见原因：代理未配置、OSS 域名不可达、DNS 解析失败 |
| `SHA-256 mismatch` | tarball 下载不完整或 CDN 缓存与 manifest 不一致。等待下一次自动重试（通常 CDN 缓存刷新后恢复） |
| `npm install` 失败 | 检查 Node.js 和 npm 是否可用：`node --version && npm --version`。常见：PATH 中无 node、npm registry 不可达 |
| 更新后 collector 启动失败 | `loongsuite-pilot rollback` 回滚到上一个版本，然后报告问题 |
| `postinstall failed, continuing` | postinstall 失败不阻塞更新流程，但可能导致 hook 未注入。手动重跑对应 agent 的 install 命令 |
| versions 目录下有大量版本目录 | GC 只保留 current + previous。多余目录可能是 GC 失败残留，可手动删除（保留 current/previous 指向的目录） |
| 回滚后 `previous` 为空 | 只安装了一个版本，没有可回滚的版本。需要重新安装 |
| `removing old version` 失败 | 文件权限问题。`ls -la ~/.loongsuite-pilot/versions/` 检查目录权限 |
