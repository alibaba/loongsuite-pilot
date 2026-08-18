# Agent 配置

[English](../agents.md) | 简体中文

本文说明如何选择 Pilot 要采集哪些 AI Coding Agent，以及是否采集敏感消息内容。

## 支持的 Agent ID

这些 ID 用于标识受支持的集成。大多数 ID 可直接用于安装参数、
`agent-control.json` 和 `config.json`；复用采集链路或输出类型不同的情况会在说明中标出。

| Agent | ID | 说明 |
|-------|----|------|
| Claude Code | `claude-code` | Hook 集成。 |
| Codex | `codex` | Hook 集成。 |
| Cursor | `cursor` | Hook 集成。 |
| Cursor CLI | `cursor-cli` | 独立检测并输出为 `cursor-cli`，但复用 Cursor 已安装的 Hook/Input 链路，不会独立部署另一套 Hook；输出内容策略使用 `cursor-cli`。 |
| DeepSeek Harness | `dsh` | 用户级 YAML patch 插件与本地 per-session JSONL 轮询；采集原生 LLM、reasoning、工具、Token 和 TTFT 数据。 |
| Hermes Agent | `hermes-agent` | 原生目录插件和本地 session 文件采集；输出记录使用 `gen_ai.agent.type=hermes`。 |
| Kiro CLI | `kiro-cli` | Hook 集成，并延迟采集本地 SQLite/session 数据；源端暂不提供 Token 用量。 |
| MiMo Code | `mimo-code` | 插件注入，采集 LLM、工具和 Token 生命周期事件。 |
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
| Wukong | `wukong` | 运行时自动发现并通过本地 `wukong-cli` 进行 CLI API 轮询；它不是 `agents.d` 安装选择项。 |
| WorkBuddy | `workbuddy` | 结构化 Hook 和文件变化触发即时采集，本地 transcript 每 30 秒轮询兜底；已在 macOS WorkBuddy Desktop 5.2.6 和 Windows 11 WorkBuddy Desktop 5.3.5.0 验证。 |

Windows 验证使用安装后的 Pilot 产物，在 `PATH` 中没有 Node 的情况下从安装器固定的
`node-bin` 解析 Node，并用真实 WorkBuddy transcript 通过严格 JSONL 校验。

Codex 使用 transcript 作为采集事实源。Pilot 通过轻量的
`SessionStart` 和 `UserPromptSubmit` Hook 发现当前实际生效的
`CODEX_HOME`（包括编排器为单个任务创建的独立目录），并采集该 session
根目录下最近活跃的 rollout 文件。`Stop` 仅作为尽力而为的唤醒信号，
目录发现不依赖它。

## DeepSeek Harness 采集与生命周期

Pilot 通过 `~/.dsh` 目录或 `dsh` 命令检测 DeepSeek Harness。启用
`dsh` 后，Pilot 会在已设置 `DSH_HOME` 时修改 `$DSH_HOME/cordis.patch.yml`，
否则修改 `~/.dsh/cordis.patch.yml`，并在其中追加一个
带 marker 的 Pilot 专属 block，用于加载
`$PILOT_DATA/plugins/dsh/plugin.mjs`；marker 外的用户及第三方内容保持原样。
首次启用或重新安装后，需要启动新的 DSH 进程，使宿主加载当前 patch。

插件将 append-only 原生事件写入
`$PILOT_DATA/logs/dsh/dsh-<session-id>.jsonl`。在 POSIX 系统上，目录权限为
`0700`，文件权限为 `0600`。这些源文件包含归一化所需的原生消息和
工具数据，应当作敏感数据保护；插件在落盘前会过滤类似凭据的 key。
`captureMessageContent` 只控制归一化输出，不会删除这些源日志中的内容。
Pilot 使用原生请求边界到首个 reasoning、text 或 tool-call stream delta
的时间差计算 LLM TTFT，并以纳秒写入
`gen_ai.response.time_to_first_token`。

`agent-control.json` 和 `config.json` 中的采集开关均使用 ID `dsh`。
禁用采集时，Pilot 会先删除 enable marker，使已加载的插件停止写入，
再只删除 Pilot 所属的 YAML block。DSH 保持启用时，运行时 watchdog
会修复该 block。卸载会在删除插件资产之前执行相同的属主清理，并保留
无关 YAML 内容。如果源事件缺少请求边界或输出 delta，Pilot 会省略 TTFT，
不会伪造为 0。

## OpenClaw 兼容性与生命周期

Pilot 支持 OpenClaw `>=2026.5.12`。插件包会声明这一最低宿主版本，
OpenClaw 在加载插件时使用当前运行版本自行校验；不兼容的宿主会跳过插件并
输出诊断，Pilot 不再通过启动 OpenClaw CLI 获取版本。部署时，Pilot 会把
插件包目录加入 `plugins.load.paths`，并向生效的 OpenClaw 配置加入以下条目：

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
权限受限的备份。升级时会把 Pilot 旧的单文件加载路径替换为插件包目录；
卸载会同时清理新旧两种路径和 Pilot 自己的条目，并保留其他插件及其配置。

注入的插件会把 append-only 源事件写入
`~/.loongsuite-pilot/logs/openclaw/`。在 POSIX 系统上，目录权限为 `0700`，
文件权限为 `0600`。Provider 错误或取消调用可能没有输出消息或 Token 用量；
Pilot 会上报原生 finish reason 和耗时，不会伪造消息或补零 Token。

## 安装时选择 Agent

使用 `--agents` 跳过交互选择：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor,dsh"
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
    "dsh": "on",
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
    "dsh": { "enabled": true, "captureMessageContent": false },
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
