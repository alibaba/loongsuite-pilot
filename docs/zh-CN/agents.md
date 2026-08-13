# Agent 配置

[English](../agents.md) | 简体中文

本文说明如何选择 Pilot 要采集哪些 AI Coding Agent，以及是否采集敏感消息内容。

## 支持的 Agent ID

这些 ID 可用于安装参数、`agent-control.json` 和 `config.json`。

| Agent | ID | 说明 |
|-------|----|------|
| Claude Code | `claude-code` | Hook 集成。 |
| Codex | `codex` | Hook 集成。 |
| Cursor | `cursor` | Hook 集成。 |
| Kiro CLI | `kiro-cli` | Hook 集成，并延迟采集本地 SQLite/session 数据；源端暂不提供 Token 用量。 |
| OpenClaw | `openclaw` | 注入插件，支持 OpenClaw 2026.5.12 及以上稳定版本；采集原生 LLM、ReAct、工具、Token、错误和取消事件。 |
| OpenCode | `opencode` | 插件注入。 |
| Pi Coding Agent | `pi-coding-agent` | 注入 Pi Extension，采集 LLM 与工具生命周期事件。 |
| Qoder | `qoder` | Hook 集成。 |
| Qoder CN | `qoder-cn` | Hook 集成。 |
| Qoder for JetBrains | `qoder-jetbrains` | 部署/检测专用 ID。`agent-control.json` 中采集开关为 `qoder`；`config.json` 中内容策略为 `qoder-idea`。 |
| Qoder CLI | `qoder` | 复用 Qoder Agent 定义，使用 Hook / session 数据源。 |
| Qoder Work | `qoder-work` | Hook 和本地数据源。 |
| Qoder Work CN | `qoder-work-cn` | Hook 和本地数据源。 |
| Qwen Code CLI | `qwen-code-cli` | Hook 集成；Stop 时解析 qwen-code transcript JSONL。 |
| Wukong | `wukong` | 通过本地 `wukong-cli` 进行 CLI API 轮询。 |
| WorkBuddy | `workbuddy` | 结构化 Hook 和文件变化触发即时采集，本地 transcript 每 30 秒轮询兜底；已在 macOS WorkBuddy Desktop 5.2.6 和 Windows 11 WorkBuddy Desktop 5.3.5.0 验证。 |

Windows 验证使用安装后的 Pilot 产物，在 `PATH` 中没有 Node 的情况下从安装器固定的
`node-bin` 解析 Node，并用真实 WorkBuddy transcript 通过严格 JSONL 校验。

Codex 使用 transcript 作为采集事实源。Pilot 通过轻量的
`SessionStart` 和 `UserPromptSubmit` Hook 发现当前实际生效的
`CODEX_HOME`（包括编排器为单个任务创建的独立目录），并采集该 session
根目录下最近活跃的 rollout 文件。`Stop` 仅作为尽力而为的唤醒信号，
目录发现不依赖它。

## OpenClaw 兼容性与生命周期

Pilot 支持 OpenClaw `>=2026.5.12` 的稳定版本。预发布版本或更早版本会在
修改 OpenClaw 配置前被拒绝。部署时，Pilot 会把自身模块路径加入
`plugins.load.paths`，并向生效的 OpenClaw 配置加入以下条目：

```json
{
  "plugins": {
    "entries": {
      "loongsuite-pilot-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

原生会话生命周期 Hook 通过 `allowConversationAccess` 提供每次 LLM 调用的
消息和用量，因此该权限是必需的。迁移旧版插件数组配置前，Pilot 会创建
权限受限的备份；升级和卸载只替换或删除 Pilot 自己的路径与条目，保留其他
插件及其配置。

注入的插件会把 append-only 源事件写入
`~/.loongsuite-pilot/logs/openclaw/`。在 POSIX 系统上，目录权限为 `0700`，
文件权限为 `0600`。Provider 错误或取消调用可能没有输出消息或 Token 用量；
Pilot 会上报原生 finish reason 和耗时，不会伪造消息或补零 Token。

## 安装时选择 Agent

使用 `--agents` 跳过交互选择：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor"
```

安装器仍会检查所选 Agent 是否存在于当前机器上，再部署对应采集能力。

## 安装后启停 Agent

使用 `~/.loongsuite-pilot/agent-control.json` 控制准入：

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "qoder": "off"
  }
}
```

| 模式 | 含义 |
|------|------|
| `on` | 当数据源存在时强制启用该 Agent。 |
| `off` | 禁用该 Agent。 |
| `auto` | 使用默认自动检测行为。 |

修改后重启：

```bash
loongsuite-pilot restart
```

## 按 Agent 配置内容采集

如果需要控制消息内容采集，使用 `config.json`：

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "openclaw": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 设置为 `false` 可从配置层禁用该 Agent。 |
| `captureMessageContent` | 设置为 `false` 可避免采集完整 Prompt、Completion、工具参数和工具结果，前提是对应集成支持该策略。 |
| `multimodal.uploadMode` | 多模态上传策略。`none`（默认）关闭；`input` / `tool` / `output` / `both` 控制转换表面。详见 [多模态采集](multimodal.md)。 |

敏感环境建议同时设置 `captureMessageContent: false` 和 [数据脱敏](masking.md)。需要提取多模态数据时，见 [多模态采集](multimodal.md)（当前仅图像；已实现 `codex` 与 `qoder` IDE/CLI）。

## 验证 Agent 采集

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

如果预期 Agent 没有数据：

- 确认 Agent 已安装且至少使用过一次。
- 确认 `agent-control.json` 中没有设置为 `off`。
- 确认 `config.json` 中没有设置 `"enabled": false`。
- 修改配置后重启 Pilot。
