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
| OpenCode | `opencode` | 插件注入。 |
| Qoder | `qoder` | Hook 集成。 |
| Qoder CN | `qoder-cn` | Hook 集成。 |
| Qoder CLI | `qoder` | 复用 Qoder Agent 定义，使用 Hook / session 数据源。 |
| Qoder Work | `qoder-work` | Hook 和本地数据源。 |
| Qoder Work CN | `qoder-work-cn` | Hook 和本地数据源。 |

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
    "cursor": { "enabled": true, "captureMessageContent": true }
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
