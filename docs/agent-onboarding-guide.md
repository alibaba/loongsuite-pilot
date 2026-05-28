# Agent Onboarding Guide

本文档说明如何将一个新的 AI Coding Agent 接入 loongsuite-pilot 的数据采集系统。

接入方式分为两种：

- **Hook 模式** — 目标 agent 原生支持 hook/callback 配置（如 Claude Code、Codex、Cursor、Qoder），直接在其配置文件中注入 hook 命令
- **Plugin-Probe 模式** — 目标 agent 需要安装一个独立插件来实现数据采集（保留作为通用扩展点，当前无活跃使用）

> **注意**：Claude Code 和 Codex 已从 Plugin-Probe 模式迁移到 Hook 模式（2026-05）。详见下方 Hook 模式示例。

---

## 核心概念

```
agents.d/<agent-id>.json        ← Agent 声明文件（必须）
assets/hooks/<hook-script>      ← Hook 脚本（Hook 模式必须）
scripts/plugin-install-*.sh     ← 安装脚本（Plugin-Probe 模式可选）
plugins/<tarball>.tar.gz        ← 插件包（Plugin-Probe 模式必须）
```

整体流程：

```
DeploymentManager.deployAll()
  → AgentDefLoader 加载 agents.d/*.json
  → 对每个 agent:
      1. detect()        — 检测 agent 是否已安装
      2. needsDeploy()   — 检查是否需要部署
      3. deploy()        — 执行部署（写 hook 或解压插件）
      4. 记录状态到 deployed-agents.json
```

---

## 方式一：Hook 模式

适用于原生支持 hook 配置文件的 agent（如 Cursor 的 `~/.cursor/hooks.json`）。

### 步骤

#### 1. 创建 Agent 声明文件

在 `agents.d/` 下创建 `<agent-id>.json`：

```jsonc
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.my-agent"],        // 检测路径，存在任一即认为已安装
    "commands": ["my-agent"]         // 或检测命令是否在 PATH 中
  },
  "hook": {
    "settingsPath": "~/.my-agent/hooks.json",  // hook 注入的目标文件
    "events": ["stop", "postToolUse"],         // 要注入的 hook 事件列表
    "hookCommand": "$PILOT_DATA/hooks/my-agent-loongsuite-pilot-hook.sh",
    "format": "flat",                          // "flat" 或 "nested"，见下文
    "matcher": "*"                             // 可选，hook 的 matcher 字段
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent/history"
  }
}
```

**JSON 定义中的变量（由 AgentDefLoader 在加载时文本替换）：**

| 变量 | 解析为 | 说明 |
|------|--------|------|
| `$PILOT_DATA` | `~/.loongsuite-pilot` | 数据目录（日志、状态、hooks 脚本） |
| `$PILOT_DIR` | `~/.loongsuite-pilot/versions/<current>/` | 当前版本的程序安装目录 |
| `~` | `/Users/<user>` | Home 目录（自动展开） |

注意：这些变量**只在 agents.d JSON 文件中可用**，不能在 shell 脚本中使用。反过来，shell 脚本的环境变量（见下方安装脚本章节）也不能在 JSON 中使用。两套变量系统完全独立。

**format 说明：**

`"flat"` — 直接数组格式（如 Cursor）：

```json
{
  "hooks": {
    "stop": [
      { "type": "command", "command": "/path/to/hook.sh" }
    ]
  }
}
```

`"nested"` — 分组格式（如 Qoder/Claude Code）：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/path/to/hook.sh" }
        ]
      }
    ]
  }
}
```

**可选字段：**

- `matcher` — hook 条目的 matcher 值，默认无
- `replaceHookCommands` — 部署时如果发现这些旧命令，先移除再注入新的（用于迁移旧版 hook）

#### 2. 编写 Hook 脚本

在 `assets/hooks/` 下创建 shell entrypoint，如 `my-agent-loongsuite-pilot-hook.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 找到 Node.js（需要 >=18）
# ... 复用已有脚本的 Node 发现逻辑 ...

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE_BIN" "$SCRIPT_DIR/hook-processor.mjs" --agent-id my-agent "$@"
```

关键原则：

- **Fail-open**：任何错误都输出 `{}` 并 exit 0，不能阻塞宿主 agent
- **读 stdin**：agent 的 hook 事件数据通过 stdin 传入（JSON 格式）
- **写 JSONL**：输出追加到 `$PILOT_DATA/logs/<agent-id>/history/<agent-id>-YYYY-MM-DD.jsonl`

可以复用已有的 `hook-processor.mjs` 或 `agent-event-normalizer.mjs` 来做数据标准化。

#### 3. 完成

`postinstall.js` 会在安装/升级时自动将 `assets/hooks/` 下的脚本复制到 `~/.loongsuite-pilot/hooks/`。

DeploymentManager 会在运行时：

- 检测到 agent 已安装 → 将 hook 命令写入其配置文件
- 如果 agent 尚未安装 → 每 5 分钟轮询一次，发现安装后自动部署
- HookWatchdog 会定期检查 hook 是否还在（防止被其他工具覆盖），丢失时自动修复

---

### Hook 模式示例

**Cursor（flat format，多事件）：**

```json
{
  "id": "cursor",
  "displayName": "Cursor",
  "deployMode": "hook",
  "detection": { "paths": ["~/.cursor"], "commands": [] },
  "hook": {
    "settingsPath": "~/.cursor/hooks.json",
    "events": [
      "stop", "preToolUse", "postToolUse", "postToolUseFailure",
      "beforeSubmitPrompt", "preCompact", "sessionStart", "sessionEnd",
      "subagentStart", "subagentStop", "afterAgentResponse", "afterAgentThought"
    ],
    "hookCommand": "$PILOT_DATA/hooks/cursor-loongsuite-pilot-hook.sh",
    "format": "flat"
  },
  "input": { "type": "hook-jsonl", "logDir": "$PILOT_DATA/logs/cursor/history" }
}
```

**Qoder CLI（nested format，单事件）：**

```json
{
  "id": "qoder",
  "displayName": "Qoder CLI",
  "deployMode": "hook",
  "detection": { "paths": ["~/.qoder"], "commands": ["qoder"] },
  "hook": {
    "settingsPath": "~/.qoder/settings.json",
    "events": ["Stop"],
    "hookCommand": "$PILOT_DATA/hooks/qoder-loongsuite-pilot-hook.sh qoder",
    "format": "nested",
    "matcher": "*"
  },
  "input": { "type": "hook-jsonl", "logDir": "$PILOT_DATA/logs/qoder/history" }
}
```

---

## 方式二：Plugin-Probe 模式

适用于需要安装独立插件（tarball）来实现采集的 agent。插件通常包含自己的 hook 注册逻辑。

### 步骤

#### 1. 准备插件 tarball

将插件打包为 `.tar.gz`，放入 `plugins/` 目录。tarball 解压后的目录结构建议：

```
package/
├── bin/           ← CLI 入口（如 otel-claude-hook）
├── src/ or dist/  ← 插件代码
├── scripts/
│   ├── install.sh    ← 插件自带的安装脚本
│   └── uninstall.sh  ← 卸载/清理脚本
├── package.json
└── ...
```

#### 2. 创建 Agent 声明文件

```jsonc
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "plugin-probe",
  "detection": {
    "paths": ["~/.my-agent"],
    "commands": ["my-agent"]
  },
  "pluginProbe": {
    "source": {
      "type": "tar",                                          // "tar"（本地 tarball）或 "oss"（远程下载）
      "tarball": "$PILOT_DIR/plugins/my-agent-plugin.tar.gz", // 本地 tarball 路径
      "destDir": "~/.cache/my-agent-plugin/package",          // 解压目标路径
      "remoteUrl": ""                                         // 可选，本地 tarball 不存在时的 fallback URL
    },
    "mountType": "wrapper"   // "wrapper" | "rc-inject" | "env-inject"，影响部署后提示信息
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

**source.type 说明：**

- `"tar"` — 优先从 `tarball` 路径解压；如果 tarball 不存在且 `remoteUrl` 非空，从远程下载
- `"oss"` — 始终从 `source.url` 远程下载

**mountType 说明：**

- `"wrapper"` — 插件通过 PATH wrapper 挂载，提示用户执行 `hash -r`
- `"rc-inject"` — 插件通过 `.bashrc/.zshrc` 注入，提示 `source ~/.bashrc`
- `"env-inject"` — 插件通过环境变量注入，提示打开新终端

#### 3. 编写安装脚本

**优先级：** DeploymentManager 查找安装脚本的顺序：

1. `$PILOT_DIR/scripts/plugin-install-<agent-id>.sh` — pilot 侧的 wrapper 脚本 （过渡期间使用这个脚本来适配claude codeh和codex）
2. 插件 `destDir/scripts/install.sh` — 插件自带的安装脚本 （推荐）

如果都不存在，只解压 tarball 不执行额外安装。

**安装脚本环境变量（由 PluginProbeStrategy 在执行脚本时注入，与 JSON 变量无关）：**

| 环境变量 | 值 | 说明 |
|----------|-----|------|
| `PILOT_DATA_DIR` | `~/.loongsuite-pilot` | 数据目录 |
| `PILOT_LOG_DIR` | `~/.loongsuite-pilot/logs/<agent-id>` | 该 agent 的日志目录 |
| `PILOT_NODE_BIN` | `/path/to/node` | Node.js 可执行文件绝对路径 |
| `PILOT_NPM_BIN` | `/path/to/npm` | npm 可执行文件绝对路径 |
| `PATH` | 原始 PATH + Node.js bin 目录 | 确保 node/npm 可直接调用 |
| `NODE_OPTIONS` | `""` (空) | 已清空，防止继承宿主进程的 `--require` |

> **两套变量系统的区别：**
> - **agents.d JSON** 中使用 `$PILOT_DATA`、`$PILOT_DIR`、`~` — 在定义加载时做文本替换
> - **install/uninstall 脚本** 中使用上表的环境变量 — 在脚本执行时通过 `env` 传入
>
> 不能混用：JSON 中写 `$PILOT_DATA_DIR` 不会被解析，脚本中写 `$PILOT_DATA` 也不会有值。

**脚本工作目录：** `destDir`（即 tarball 解压的目标目录）

**示例（`scripts/plugin-install-claude-code.sh`）：**

```bash
#!/usr/bin/env bash
set -uo pipefail

DEST_DIR="$(pwd)"
NODE_BIN="${PILOT_NODE_BIN:-node}"
NPM_BIN="${PILOT_NPM_BIN:-npm}"
LOG_DIR="${PILOT_LOG_DIR:-}"

# 1. 安装依赖
"$NPM_BIN" install --production --silent || exit 1

# 2. 注册 hook 到 agent 配置文件
"$NODE_BIN" "$DEST_DIR/bin/otel-claude-hook" install --user --no-alias --quiet 2>/dev/null || true

# 3. 写采集配置（指定日志目录）
CONFIG="$HOME/.claude/otel-config.json"
mkdir -p "$(dirname "$CONFIG")"
# ... 写入 log_dir 等配置 ...
mkdir -p "$LOG_DIR"
```

#### 4. 编写卸载脚本

在插件的 `scripts/uninstall.sh` 中实现清理逻辑。DeploymentManager 在更新（hash 变化）时会先执行 uninstall 再重新部署。

#### 5. 打包

确保 `deploy/package.sh` 会将 `plugins/` 和 `agents.d/` 打入发布包：

```bash
# agents.d 已自动打包
# plugins/*.tar.gz 已自动打包（见 package.sh）
```

---

### Hook 模式示例：Claude Code（8 事件 + nested format）

```json
{
  "id": "claude-code",
  "displayName": "Claude Code",
  "deployMode": "hook",
  "detection": { "paths": ["~/.claude"], "commands": ["claude"] },
  "hook": {
    "settingsPath": "~/.claude/settings.json",
    "events": ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop",
               "PreCompact", "SubagentStart", "SubagentStop", "Notification"],
    "hookCommand": "$PILOT_DATA/hooks/claude-code-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*",
    "eventSubcommand": "kebab-case"
  },
  "input": { "type": "hook-jsonl", "logDir": "$PILOT_DATA/logs/claude-code" }
}
```

### Hook 模式示例：Codex（5 事件 + trust hash）

```json
{
  "id": "codex",
  "displayName": "Codex",
  "deployMode": "hook",
  "detection": { "paths": ["~/.codex"], "commands": [] },
  "hook": {
    "settingsPath": "~/.codex/hooks.json",
    "events": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    "hookCommand": "$PILOT_DATA/hooks/codex-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*",
    "eventSubcommand": "kebab-case",
    "trustToml": {
      "configPath": "~/.codex/config.toml",
      "trustAlgo": "v1",
      "marker": "otel-codex-hook"
    }
  },
  "input": { "type": "hook-jsonl", "logDir": "$PILOT_DATA/logs/codex" }
}
```

**Codex 特殊说明**：Codex v0.125+ 强制 hook trust 机制，`trustToml` 配置让 pilot 在 deploy 时动态计算 trust hash 并写入 `~/.codex/config.toml`。如使用 Codex 桌面版，首次启动需手动信任 hooks。

### Plugin-Probe 模式示例（已弃用，保留作为通用扩展点）

> ⚠️ Claude Code 和 Codex 已迁移到 Hook 模式。以下示例仅供参考。

---

## 部署生命周期

### 首次安装

```
postinstall.js 复制 assets/hooks/* → ~/.loongsuite-pilot/hooks/
服务启动 → deployAll() → 检测/部署每个 agent
```

### 升级

```
updater 下载新版 → npm install（触发 postinstall，更新 hook 脚本文件）→ 重启服务
新服务 deployAll():
  - Hook 模式：检查 hook 是否已注册 → 已有则跳过
  - Plugin-Probe：对比 tarball SHA-256 → hash 变了则 uninstall + 重新部署
```

### 动态发现

Agent 在 pilot 运行期间才被安装的场景：

- `buildDeployDetectionEntries()` 注册 5 分钟轮询
- 检测到 `detection.paths` 存在后自动触发 `deploySingle()`

### Hook 自动修复

- HookWatchdog 每 5 分钟检查所有已注册 hook 是否还在目标配置文件中
- 如果被其他工具覆盖/删除，自动重新注入

---

## 添加新 Agent 的 Checklist

### Hook 模式

- 创建 `agents.d/<agent-id>.json`
- 确认 `format` 是 `"flat"` 还是 `"nested"`（查看目标 agent 的配置文件格式）
- 编写 `assets/hooks/<agent-id>-loongsuite-pilot-hook.sh`（shell entrypoint）
- 如果无法复用已有 processor，编写对应的 `.mjs` 处理器
- 在 `agent-event-normalizer.mjs` 中添加标准化逻辑（如果需要）
- 确认对应的 Input 类已实现（`src/inputs/`）

### Plugin-Probe 模式

- 准备插件 tarball，放入 `plugins/`
- 创建 `agents.d/<agent-id>.json`
- 编写 `scripts/plugin-install-<agent-id>.sh`（或插件自带 `scripts/install.sh`）
- 推荐：插件提供 `scripts/uninstall.sh`
- 确认对应的 Input 类已实现（`src/inputs/`）

---

## 调试

查看部署状态：

```bash
cat ~/.loongsuite-pilot/deployed-agents.json
```

查看服务日志中 DeploymentManager 的行为：

```bash
grep -E "DeploymentManager|PluginProbeStrategy|HookStrategy|AgentDefLoader" \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
```

查看 HookWatchdog 检查结果：

```bash
grep "hook-watchdog.check" ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
```

手动验证 agent 定义加载：

```bash
ls ~/.loongsuite-pilot/versions/$(cat ~/.loongsuite-pilot/current)/agents.d/
```

