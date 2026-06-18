# 产品概览

[English](../overview.md) | 简体中文

LoongSuite Pilot 运行在开发者本机，用于采集支持的 AI Coding Agent 遥测数据。它适合需要统一查看 Agent 使用情况、模型调用、工具活动、token 用量和运行状态的团队。

## 核心能力

| 能力 | 说明 |
|------|------|
| Agent 发现 | 通过本地路径和命令检测已安装的支持 Agent。 |
| 采集能力部署 | 为支持的 Agent 安装 Hook 或插件，必要时读取本地日志或会话文件。 |
| 活动归一化 | 将不同 Agent 的原生事件转换为统一的 GenAI 事件 Schema。 |
| 日志上报 | 将规范化事件输出到 JSONL、SLS 或 HTTP。 |
| Trace 上报 | 将 GenAI 会话和工具活动导出为 OTLP Trace。 |
| Token 用量 | 当源 Agent 暴露数据时，采集输入、输出、缓存读取和缓存写入 token。 |
| 工具活动 | 采集工具名称、参数、结果、耗时和错误信息。 |
| 隐私控制 | 支持按 Agent 关闭消息内容采集，并在输出前脱敏密钥。 |
| 本地运维 | 管理后台服务、查看状态、启动可选 Dashboard，并支持版本回滚。 |

## 支持的 Agent

| Agent | 集成方式 | Trace 上报 | 日志上报 | Token 用量 | 对话 / 工具调用 |
|-------|----------|------------|----------|------------|----------------|
| Claude Code | Hook | Yes | Yes | Yes | Yes |
| Codex | Hook | Yes | Yes | Yes | Yes |
| Cursor | Hook | Yes | Yes | Yes | Yes |
| OpenCode | 插件注入 | Yes | Yes | Yes | Yes |
| Qoder | Hook | Yes | Yes | Yes | Yes |
| Qoder CN | Hook | Yes | Yes | Yes | Yes |
| Qoder CLI | Hook / session polling | Yes | Yes | No | Yes |
| Qoder Work | Hook / 本地数据轮询 | Yes | Yes | No | Yes |
| Qoder Work CN | Hook / 本地数据轮询 | Yes | Yes | No | Yes |

## 采集的数据

Pilot 关注对使用分析、审计和链路追踪有价值的活动：

- LLM 请求和响应。
- 用户会话、轮次和 Agent 中间步骤。
- 工具调用、工具结果、工具耗时和工具错误。
- 源 Agent 可提供时的 token 用量和费用相关字段。
- 模型 Provider 和模型名称。
- Git 仓库、分支和当前 workspace root。
- 主机和服务元数据。
- Agent 暴露的扩展上下文字段。

消息内容、工具参数和工具结果可能包含敏感信息。这些字段在 [输出事件 Schema](output-event-schema.md) 中标记为 opt-in，可按 Agent 关闭内容采集，也可在输出前脱敏。

## 输出目标

Pilot 可以将同一份规范化事件流输出到多个目标：

| 目标 | 典型用途 |
|------|----------|
| JSONL | 本地备份、调试和离线查看。 |
| SLS | 阿里云日志服务中的集中检索、分析和告警。 |
| HTTP | 自定义采集网关或服务端。 |
| OTLP Trace | Trace 后端、APM 或 GenAI 可观测平台。 |

如果没有配置远端后端，JSONL 默认保持开启，方便本地验证采集是否生效。

## 本地运行目录

默认数据目录：

```text
~/.loongsuite-pilot/
```

重要文件和目录：

| 路径 | 用途 |
|------|------|
| `config.json` | 主配置文件。 |
| `agent-control.json` | Agent 准入控制：`on`、`off` 或 `auto`。 |
| `deployed-agents.json` | 已部署 Hook 和插件的记录。 |
| `hooks/` | 已安装的 Hook 脚本。 |
| `plugins/` | 已安装的插件资产。 |
| `logs/output/` | 本地规范化 JSONL 输出。 |
| `logs/input-state.json` | 输入源偏移和 checkpoint。 |
| `sls-failed-logs/` | SLS 上报失败的本地持久化记录。 |
| `versions/` 和 `current` | 用于升级和回滚的版本目录与指针。 |

## 下一步

- 通过 [安装指南](installation.md) 安装 Pilot。
- 在 [配置总览](configuration.md) 了解全局配置。
- 在 [Agent 配置](agents.md) 选择采集哪些 Agent。
- 在 [本地 JSONL 输出](local-jsonl-output.md) 验证本地输出。
- 在 [SLS 输出](sls-output.md) 配置 SLS 上报。
- 在 [Trace 输出](trace-output.md) 配置 Trace 上报。
- 在 [HTTP 输出](http-output.md) 配置自定义 HTTP 上报。
- 在 [数据脱敏](masking.md) 配置密钥脱敏。
- 在 [输出事件 Schema](output-event-schema.md) 查看字段。
- 在 [新 Agent 接入](agent-onboarding.md) 增加新的 Agent 支持。
