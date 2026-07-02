# HookWatchdog 自愈机制 — 排查与开发指南

HookWatchdog 是 pilot daemon 内置的巡检器，每 5 分钟（`intervalMs`，默认 300000ms）检测 hook 注册和 intercept 注入是否丢失，丢失时自动修复。启动后有 30 秒延迟再开始第一次巡检。

它管两类检测目标：
- **Hook targets**：检测 agent settings.json 中的 hook 命令条目（如 `~/.claude/settings.json` 的 `hooks.Stop` 数组）
- **Intercept targets**：检测 launchctl 环境变量、LaunchAgent plist、shell rc wrapper function 等注入配置

与 installer 的关系：installer（`deploy/installer-opensource.sh`）做一次性注入，watchdog 做持续自愈。两者用相同的 marker / block 格式，互相兼容。

## Hook Targets — settings.json 检测

检测 agent settings.json 文件中 `hooks.<event>` 数组是否包含 pilot 的 hook 命令条目。

targets 来源有两种：
- `HookWatchdog.defaultTargets()`：硬编码的 otel plugin 类（claude-code / codex），用外部安装命令修复
- `orchestrator.buildHookWatchdogTargets()`：从 `agents.d/*.json` 中 `deployMode: "hook"` 的定义动态构建，用 `DeploymentManager.deploySingle()` 修复

修复方式二选一：
- **repairFn**（优先）：调用 `DeploymentManager.deploySingle(def)` 重新执行 `HookStrategy.deploy()`，重写 settings.json hook 条目
- **binPath + installArgs**：spawn 外部安装命令（如 `otel-claude-hook install`），30 秒超时

**给新插件添加 hook target**：在 `agents.d/<agent>.json` 中设置 `deployMode: "hook"` 并配好 `hook.settingsPath`、`hook.events`、`hook.hookCommand`，orchestrator 启动时会自动为该 agent 构建 watchdog target，无需改 TypeScript 代码。

## Intercept Targets — launchctl / shell rc 检测

检测 installer 注入的 intercept 配置是否仍然存在。与 hook targets 不同，intercept targets 检测的不是 settings.json，而是系统级配置（launchctl env、LaunchAgent plist、shell rc 文件）。

当前 3 个 intercept target：

| target id | 平台 | 检测什么 | 修复方式 |
|---|---|---|---|
| `qoderwork-env` | macOS | `launchctl getenv QODER_WORKER_RUNTIME_PATH` 是否等于 wrapper 路径 | `launchctl setenv` + 写/重载 `~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist` |
| `qodercli-rc` | macOS + Linux | `~/.zshrc` 或 `~/.bashrc`（按 `$SHELL` 判断）是否含 `# loongsuite-pilot BEGIN qodercli-intercept` marker | 向 rc 文件末尾 append wrapper function block |
| `claude-code-rc` | macOS + Linux | 同上，marker 为 `# loongsuite-pilot BEGIN claude-code-intercept` | 同上 |

前置条件（precondition）：对应的 hook 脚本文件必须存在（如 `~/.loongsuite-pilot/hooks/qodercli-token-intercept.mjs`）。对 `qoderwork-env` 还要求 macOS 平台且 QoderWork.app 已安装。前置条件不满足时静默 skip，不算修复失败。

## 安全护栏

| 护栏 | 作用 |
|---|---|
| **repair cooldown** | `repairCooldownMs`（默认 600000ms = 10 分钟），同一 target 10 分钟内不重复修复 |
| **daily limit** | intercept targets 每日最多 3 次修复。防止 dotfile 管理工具（chezmoi / stow 等）覆盖 rc 后与 watchdog 无限循环。超限后 log `intercept-watchdog.daily-limit` 并停止当日修复 |
| **append-only** | rc 文件只追加，不修改已有内容。即使 append 被中断（断电等），原文件不受影响 |
| **不创建 rc 文件** | 如果 `~/.zshrc` / `~/.bashrc` 不存在，跳过修复（不会凭空创建 rc 文件） |
| **double-check** | repair 前再次 check 确认仍缺失（防并发/竞态写入重复 block） |
| **try-catch** | 单个 target 修复失败只写 warn 日志，不影响其它 target 和 watchdog 后续运行 |

## 给新插件添加 intercept watchdog 支持

### Step 1：确定注入类型

- **macOS GUI app**（如 QoderWork）→ `launchctl setenv` + LaunchAgent plist（参考 `qoderwork-env`）
- **CLI 工具**（如 qodercli / claude）→ shell rc wrapper function（参考 `qodercli-rc`）

### Step 2：在 `hook-watchdog.ts` 的 `defaultInterceptTargets()` 加 target

```typescript
targets.push({
  id: '<agent>-rc',  // 或 '<agent>-env' for launchctl 场景
  precondition: async () => {
    return fileExists(path.join(dataDir, 'hooks', '<hook-script>.mjs'));
  },
  check: async () => {
    // rc 场景：读 rc 文件 grep marker
    const content = await fs.readFile(rcPath, 'utf-8');
    return content.includes('loongsuite-pilot BEGIN <agent>-intercept');
    // launchctl 场景：execFileAsync('launchctl', ['getenv', '<ENV_VAR>'])
  },
  repair: async () => {
    // rc 场景：appendFile(rcPath, block)
    // launchctl 场景：execFileAsync('launchctl', ['setenv', ...]) + 写 plist
  },
});
```

### Step 3：rc block marker 命名规范

```
# loongsuite-pilot BEGIN <id>-intercept
<wrapper function definition>
# loongsuite-pilot END <id>-intercept
```

watchdog 和 installer **必须用同一个 marker**。watchdog 的 check 用 `BEGIN` marker 判定存在性，installer 的 inject 函数用同样的 grep 做幂等检查。

### Step 4：在 installer.sh 加对应函数

在 `deploy/installer-opensource.sh` 中添加 `inject_<agent>_<type>()` 和 `remove_<agent>_<type>()` 函数，在 `cmd_install` 调用链中注册。installer 做一次性注入 + 卸载清理，watchdog 做运行时自愈——两者用相同的 block 内容和 marker。

### Step 5：加单测

在 `tests/unit/core/hook-watchdog-intercept.test.ts` 中添加新 target 的 check / repair / precondition 用例，mock `execFile` 和 `fs` 操作。

## 排查指南

### watchdog 是否在跑

```bash
grep 'scheduling hook watchdog' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
# 期望：看到 intervalMs + targets 列表
```

### 巡检结果

```bash
# hook targets 巡检（INFO 级别，每个 target 一行）
grep 'hook-watchdog.check' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20

# intercept targets 巡检（健康状态是 DEBUG 级别，默认不输出；修复事件是 WARN/INFO）
grep 'intercept-watchdog' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20
```

### 修复事件

```bash
# 看到这两行 = watchdog 检测到缺失并成功修复
grep 'intercept-watchdog.repairing\|intercept-watchdog.repaired' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
```

### 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| intercept target 一直 skip | hook 脚本未部署（`~/.loongsuite-pilot/hooks/<script>.mjs` 不存在） | 跑 `node scripts/postinstall.js` 或 `bash scripts/local-reinstall.sh` |
| `qoderwork-env` skip | 非 macOS 平台，或 QoderWork.app 未安装 | 仅 macOS + QoderWork.app 已安装时生效 |
| rc block 反复被修复又丢失 | dotfile 管理工具覆盖 `.zshrc` | 将 pilot block 加入 dotfile 源文件；watchdog 每日最多修复 3 次后自动停止 |
| `intercept-watchdog.daily-limit` | 同上，已达当日上限 | 次日自动重置计数 |
| `intercept-watchdog.repair-failed` | 文件权限、磁盘满、launchctl 异常 | 检查 warn 日志中的 error 详情 |
