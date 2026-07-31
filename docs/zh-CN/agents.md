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
| Grok Build | `grok-build` | 四个 fail-open Hook + 本地 session 日志融合，采集 LLM、Token、工具、取消和失败生命周期。 |
| Kiro CLI | `kiro-cli` | Hook 集成，并延迟采集本地 SQLite/session 数据；源端暂不提供 Token 用量。 |
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

### Grok Build 采集

当 `~/.grok` 存在时，Pilot 会检测到 Grok Build，并在
`~/.grok/hooks/loongsuite-pilot.json` 中安装四个 fail-open Hook：
`stop`、`stop_failure`、`user_prompt_submit` 和 `session_end`。当前不支持
subagent Hook；部署时会清理 Pilot 旧版本遗留的 subagent 和工具 Hook。

每个完成的 turn 会融合 Grok 自身的三类 JSONL 数据：

- session 目录下的 `chat_history.jsonl`：消息、模型元数据、工具参数和
  system instruction。
- session 目录下的 `updates.jsonl`：prompt 标识、turn 完成状态、取消、
  失败和工具状态。
- `~/.grok/logs/unified.jsonl`：模型时间、Token、工具耗时和执行结果。

Pilot 从安装后观察到的当前 turn 开始采集，不回放更早的 session 历史。
由于 Grok 异步持久化最终取消状态，取消 turn 可能在下一次
`UserPromptSubmit` 或 `SessionEnd` 时补采。将
`agents["grok-build"].captureMessageContent` 设置为 `false`，会同时清除
user、assistant、system 内容、工具参数、工具结果和原始错误详情。

安装产物同时包含 POSIX 和 PowerShell Hook 启动器。总体支持表不代表已完成
Windows 安装态验证；在完成真实 Windows E2E 前，Grok Build 不列入明确的
Windows 支持矩阵。

## 安装时选择 Agent

使用 `--agents` 跳过交互选择：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor"
```

仅安装 Grok Build：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "grok-build"
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
    "cursor": { "enabled": true, "captureMessageContent": true },
    "grok-build": { "enabled": true, "captureMessageContent": false }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 设置为 `false` 可从配置层禁用该 Agent。 |
| `captureMessageContent` | 设置为 `false` 可避免采集完整 Prompt、Completion、工具参数和工具结果，前提是对应集成支持该策略。 |

敏感环境建议同时设置 `captureMessageContent: false` 和 [数据脱敏](masking.md)。

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
