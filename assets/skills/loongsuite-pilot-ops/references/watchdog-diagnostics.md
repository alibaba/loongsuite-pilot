# HookWatchdog 自愈机制 — 排查与开发指南

HookWatchdog 是 pilot daemon 内置的巡检器，每 5 分钟（`intervalMs`，默认 300000ms）检测 hook 注册和 intercept 注入是否丢失，丢失时自动修复。启动后有 30 秒延迟再开始第一次巡检。

它管两类检测目标：
- **Hook targets**：检测 agent settings.json 中的 hook 命令条目（如 `~/.claude/settings.json` 的 `hooks.Stop` 数组）
- **Intercept targets**：检测 launchctl 环境变量、LaunchAgent plist、shell rc wrapper function 等注入配置

与 installer 的关系：installer（`deploy/installer-opensource.sh`）做一次性注入，watchdog 做持续自愈。两者用相同的 marker / block 格式，互相兼容。

## Hook Targets — settings.json 检测

检测 agent settings.json 文件中 `hooks.<event>` 数组是否包含 pilot 的 hook 命令条目。

targets 来源：
- `orchestrator.buildHookWatchdogTargets()`：从 `agents.d/*.json` 中 `deployMode: "hook"` 的定义动态构建，用 `DeploymentManager.deploySingle()` 修复。每个 target 带 `enabled()` 门禁（`config.agents[id].enabled !== false`），被禁用的 agent 运行期跳过，不再重注入。
- （已移除）早期的 `HookWatchdog.defaultTargets()` 硬编码 otel plugin 目标已删除：claude-code / codex 已是 hook 模式并由上面的动态构建覆盖，旧 otel 缓存目录也由 plugin-migration 主动清理。

修复方式二选一：
- **repairFn**（优先）：调用 `DeploymentManager.deploySingle(def)` 重新执行 `HookStrategy.deploy()`，重写 settings.json hook 条目
- **binPath + installArgs**：spawn 外部安装命令（如 `otel-claude-hook install`），30 秒超时

**给新插件添加 hook target**：在 `agents.d/<agent>.json` 中设置 `deployMode: "hook"` 并配好 `hook.settingsPath`、`hook.events`、`hook.hookCommand`，orchestrator 启动时会自动为该 agent 构建 watchdog target，无需改 TypeScript 代码。

## Intercept Targets — launchctl / shell rc 检测

检测 installer 注入的 intercept 配置是否仍然存在。与 hook targets 不同，intercept targets 检测的不是 settings.json，而是系统级配置（launchctl env、LaunchAgent plist、shell rc 文件）。

以下 runtime 环境变量目标全部已退役，只做清理；shell intercept 仍按原机制维护：

| target id | 平台 | 检测什么 | 修复方式 |
|---|---|---|---|
| `qoderwork-env`（已退役） | macOS | 不再检测，每轮巡检直接走禁用清理路径 | 不再注入；仅在精确等于 pilot wrapper 路径时 `launchctl unsetenv QODER_WORKER_RUNTIME_PATH`，并卸载删除 `~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist` |
| `qwenworkcn-env`（已退役） | macOS | 每轮巡检直接走禁用清理路径 | 仅在精确等于 pilot wrapper 路径时 `launchctl unsetenv QW_QODER_WORKER_RUNTIME_PATH`，并卸载删除 `~/Library/LaunchAgents/com.loongsuite-pilot.qwenworkcn-env.plist` |
| `qoderwork-win-env`（已退役） | Windows | 不再检测，每轮巡检直接走禁用清理路径 | 不再注入；仅在 `HKCU\Environment` 中的值精确等于 pilot wrapper 路径时删除 `QODER_WORKER_RUNTIME_PATH` |
| `qwenworkcn-win-env`（已退役） | Windows | 每轮巡检直接走禁用清理路径 | 仅在 `HKCU\Environment` 中的值精确等于 pilot wrapper 路径时删除 `QW_QODER_WORKER_RUNTIME_PATH`，并广播变更 |
| `qodercli-rc` | macOS + Linux | `~/.zshrc` 或 `~/.bashrc`（按 `$SHELL` 判断）是否含 `# loongsuite-pilot BEGIN qodercli-intercept` marker | 向 rc 文件末尾 append wrapper function block |
| `claude-code-rc` | macOS + Linux | 同上，marker 为 `# loongsuite-pilot BEGIN claude-code-intercept` | 同上 |

shell 目标的前置条件（precondition）要求对应 hook 脚本存在（`qodercli-rc` 对应
`~/.loongsuite-pilot/hooks/qodercli-runtime-wrapper.sh`）。不满足时静默 skip，不算修复失败。

Qoder Work、Qoder Work CN、Qwen Work CN 全部使用原生数据，不再触发 runtime 注入。
四个 runtime 目标的 `enabled()` 恒为 false，直接清理两个旧覆盖，不依赖 agent 开关、
应用或 wrapper 是否存在；第三方设置的同名变量因精确匹配而保留。
wrapper 文件只为仍持有旧环境的进程透明转发到宿主自身 runtime，不再执行截获。
安装器在停止旧服务并部署新版后、启动新服务前清理覆盖；macOS 同时移除两个 Pilot plist，
Windows 删除对应 User 环境变量并尝试通知 Explorer。已启动应用需完全退出再打开，广播失败时需重新登录。

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

- **macOS GUI app** → 优先使用原生数据源；不要把已退役的 `qwenworkcn-env` 当作注入模板
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
| `qoderwork-env` / `qoderwork-win-env` skip | 该目标已退役，`enabled()` 恒为 false | 正常现象；它每轮只清理旧的 `QODER_WORKER_RUNTIME_PATH` 注入，不再注入任何东西 |
| `qwenworkcn-env` / `qwenworkcn-win-env` skip | 平台不匹配、Qwen Work CN 未启用或 QwenWorkCN 未安装 | 仅对已启用且已安装的 Qwen Work CN 生效 |
| rc block 反复被修复又丢失 | dotfile 管理工具覆盖 `.zshrc` | 将 pilot block 加入 dotfile 源文件；watchdog 每日最多修复 3 次后自动停止 |
| `intercept-watchdog.daily-limit` | 同上，已达当日上限 | 次日自动重置计数 |
| `intercept-watchdog.repair-failed` | 文件权限、磁盘满、launchctl 异常 | 检查 warn 日志中的 error 详情 |
