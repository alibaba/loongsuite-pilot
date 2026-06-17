# 新 Agent 接入

[English](../agent-onboarding.md) | 简体中文

当你希望 LoongSuite Pilot 采集新的 AI Coding Agent 数据时，使用本文作为接入指南。目标是让新集成在用户视角下和已有 Agent 一样：可自动检测、可配置，并通过同一套事件 Schema 和输出后端导出。

## 选择集成方式

优先选择目标 Agent 支持的最轻量集成方式。

| 集成方式 | 适用场景 |
|----------|----------|
| Hook | Agent 可以在生命周期、Prompt、响应或工具事件上执行命令。 |
| 插件注入 | Agent 可以从配置文件加载本地插件。 |
| 本地日志或 session 轮询 | Agent 已经写入结构化本地文件。 |
| SQLite 轮询 | Agent 将活动存储在本地 SQLite 数据库。 |
| CLI 或 API 轮询 | Agent 暴露本地命令或 API 可读取活动数据。 |

如果 Hook 或插件可以输出结构化事件，优先使用它们。这通常更容易归一化，也更容易覆盖工具调用和 token 用量。

## 必要组成

一个新的 Agent 集成通常需要：

1. `agents.d/<agent-id>.json` 中的 Agent 定义。
2. 产生活动记录的 Hook、插件或轮询数据源。
3. 将源记录转换为 `AgentActivityEntry` 的 Input 实现。
4. 新 Agent 对应的 `ClientType` 值。
5. 如果不是完全通用的输入，还需要在 collector 启动路径中注册。
6. 测试或 fixture，证明规范化输出符合 [输出事件 Schema](output-event-schema.md)。

## Agent 定义

Agent 定义描述 Pilot 如何检测和部署集成。内置定义从 `agents.d/*.json` 加载；运行时本地定义可以从 `~/.loongsuite-pilot/agents.d.local/` 覆盖内置定义。

Hook 示例：

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.my-agent"],
    "commands": ["my-agent"]
  },
  "hook": {
    "settingsPath": "~/.my-agent/settings.json",
    "events": ["Stop", "PreToolUse", "PostToolUse"],
    "hookCommand": "$PILOT_DATA/hooks/my-agent-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

插件注入示例：

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "plugin-inject",
  "detection": {
    "paths": ["~/.config/my-agent"],
    "commands": ["my-agent"]
  },
  "pluginInject": {
    "configPaths": [
      "~/.config/my-agent/config.json"
    ],
    "pluginSpec": "file://$PILOT_DATA/plugins/my-agent/plugin.mjs",
    "pluginId": "loongsuite-pilot-my-agent"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

关键字段：

| 字段 | 作用 |
|------|------|
| `id` | 稳定 Agent ID，用于配置、输出和准入控制。 |
| `displayName` | 用户可读 Agent 名称。 |
| `deployMode` | `hook`、`plugin-inject` 或 `plugin-probe`。 |
| `detection.paths` | 可用于判断 Agent 是否安装的本地路径。 |
| `detection.commands` | 可用于判断 Agent 是否安装的命令。 |
| `hook` | Hook settings 路径、事件、命令和格式。Hook 模式必填。 |
| `pluginInject` | 配置路径和插件 spec。插件注入模式必填。 |
| `input` | collector input 使用的数据源类型和位置。 |

## 尽早输出规范化记录

对于 Hook 和插件集成，建议让 Hook 或插件写 newline-delimited JSON 到：

```text
~/.loongsuite-pilot/logs/<agent-id>/<agent-id>-YYYY-MM-DD.jsonl
```

尽可能使用 canonical dotted fields：

```json
{
  "time_unix_nano": "1778586618041000000",
  "observed_time_unix_nano": "1778586618041000000",
  "event.id": "event-uuid",
  "event.name": "tool.result",
  "user.id": "user-id",
  "gen_ai.session.id": "session-id",
  "gen_ai.agent.type": "my-agent",
  "gen_ai.provider.name": "openai",
  "gen_ai.tool.name": "bash",
  "gen_ai.tool.call.id": "call-id",
  "gen_ai.tool.call.duration": 423
}
```

Source-specific 字段建议放在 `agent.<agent-id>.*` 下，避免污染公共稳定字段。

## 实现 Input

根据数据源选择已有输入风格：

| 数据源 | 推荐 Input 风格 |
|--------|-----------------|
| Hook 或插件 JSONL | 继承 `BaseHookInput`；如果源记录已使用 canonical dotted fields，可复用 `transformHookRecord`。 |
| 本地 session 文件 | 继承 `BaseSessionInput`。 |
| SQLite 数据库 | 继承 `BaseSqliteInput`。 |
| IDE history snapshot | 继承 `BaseIdeInput`。 |
| CLI telemetry 文件 | 继承 `BaseCliForwarder`。 |
| 本地 CLI/API | 直接继承 `BaseInput`。 |

Input 应该：

- 只增量读取新记录。
- 在重启后保留 checkpoint。
- 发出 `AgentActivityEntry`。
- 除非策略允许，否则避免导出原始敏感内容。
- 可获取时附加稳定的 session、turn、tool call 和 error 标识。

## 注册 Agent

需要自定义 input class 时：

1. 在 `src/types/client-type.ts` 增加 Agent。
2. 在 `src/core/orchestrator.ts` 导入并注册 input。
3. 关联 listener ID 与公开 Agent ID，确保 `agent-control.json` 和 `config.agents` 生效。
4. 如果 input 需要轮询，增加默认 listener 配置。
5. 在 `agents.d/` 增加内置 Agent 定义。

如果新集成符合已有 Hook 或插件记录格式，可以复用已有 base input 和 `transformHookRecord`，减少代码变化。但 input 仍然需要在 collector 启动路径中注册。

## 隐私检查清单

标记集成为 ready 前，请确认：

- 对 Prompt、Completion、工具参数和工具结果支持 `captureMessageContent: false`，前提是源 Agent 暴露这些字段。
- 除非必须并可被脱敏，否则不要将密钥放入 source-specific 扩展字段。
- 验证 `mask.mode: all` 能在输出中脱敏 API Key、AccessKey、私钥和数据库 URL。见 [数据脱敏](masking.md)。
- Hook 或插件必须 fail open，遥测失败不能阻塞原 Agent。

## 测试清单

至少添加测试或 fixture 覆盖：

- Agent 检测和部署定义解析。
- Hook 或插件记录生成。
- Input checkpoint 和增量读取。
- 规范化 `event.name`。
- LLM request / response 字段。
- Tool call / result 关联。
- 源 Agent 暴露 usage 时的 token 字段。
- 内容采集关闭模式。
- 脱敏开启模式。

## 用户文档清单

新增公开 Agent 时，更新：

- [README](../../README.zh-CN.md) 和 [产品概览](overview.md) 中的支持 Agent 表。
- 如果 Agent 需要特殊配置，更新配置示例。
- 如果 Agent 会输出新的敏感内容字段，更新 [数据脱敏](masking.md)。
- 只有新增稳定公共字段时，才更新 [输出事件 Schema](output-event-schema.md)。
