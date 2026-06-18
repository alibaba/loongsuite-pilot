# LoongSuite Pilot

[English](README.md) | 简体中文

[快速开始](#快速开始) | [文档](#文档) | [新 Agent 接入](docs/zh-CN/agent-onboarding.md) | [许可证](#许可证)

LoongSuite Pilot 是一个运行在开发者本机的 AI Coding Agent 遥测采集器。它可以发现本机已安装的支持 Agent，部署所需的 Hook 或插件，将不同 Agent 的活动数据归一化为统一的 GenAI 事件 Schema，并输出到本地日志、SLS、HTTP 或 Trace 后端。

## 为什么需要 LoongSuite Pilot？

团队里常常会同时使用多个 AI Coding Agent，而每个 Agent 的本地数据格式、Hook 机制和日志结构都不一样。Pilot 提供一个统一的本机采集器，负责发现 Agent、采集活动、统一字段，并把数据送到适合分析、审计和可观测性的目标端。

Pilot 主要帮助回答这些问题：

- 当前哪些 Agent 正在被使用？
- 发生了哪些模型调用、会话、轮次和工具调用？
- 哪些 Agent 可以采集到 token 用量？
- 数据应该输出到哪里：本地文件、SLS、HTTP，还是 Trace？
- 敏感 Prompt、工具参数和密钥在上报前如何控制？

## 核心能力

| 能力 | Pilot 做什么 |
|------|-------------|
| Agent 发现 | 通过本地路径和命令检测支持的 Agent。 |
| 采集能力部署 | 安装 Hook 或插件，并读取本地日志、会话或数据文件。 |
| 统一事件 Schema | 将 Agent 原生事件归一化为统一的 GenAI 事件字段。 |
| 多目标输出 | 支持 JSONL、阿里云 SLS、HTTP 和 OTLP Trace。 |
| 隐私控制 | 支持按 Agent 控制内容采集，并在输出前进行密钥脱敏。 |
| 本地运维 | 提供状态查看、重启、回滚和可选本地 Dashboard。 |

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

Agent 定义位于 `agents.d/`。如需接入新的 Agent，请参考 [新 Agent 接入](docs/zh-CN/agent-onboarding.md)。

## 快速开始

前置要求：

- Node.js 18 或更高版本
- `npm`
- `curl` 或 `wget`

从公开包安装：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

验证服务状态：

```bash
loongsuite-pilot status
loongsuite-pilot info
```

默认会开启本地 JSONL 输出，路径为 `~/.loongsuite-pilot/logs/output/`。

安装参数、卸载命令和源码运行方式见 [安装指南](docs/zh-CN/installation.md)。

## 配置 Pilot

配置优先级为：环境变量 > `~/.loongsuite-pilot/config.json` > 内置默认值。

根据你要做的事情选择文档：

| 任务 | 文档 |
|------|------|
| 选择采集哪些 Agent，控制内容采集策略 | [Agent 配置](docs/zh-CN/agents.md) |
| 写入本地 JSONL 日志 | [本地 JSONL 输出](docs/zh-CN/local-jsonl-output.md) |
| 上报日志到 SLS | [SLS 输出](docs/zh-CN/sls-output.md) |
| 上报 OTLP Trace | [Trace 输出](docs/zh-CN/trace-output.md) |
| POST 到 HTTP 接口 | [HTTP 输出](docs/zh-CN/http-output.md) |
| 输出前进行密钥脱敏 | [数据脱敏](docs/zh-CN/masking.md) |
| 查看全局配置加载顺序和保留策略 | [配置总览](docs/zh-CN/configuration.md) |

## 输出数据

| 后端 | 用途 |
|------|------|
| JSONL | 本地备份和调试查看，默认开启。 |
| SLS | 上报到阿里云日志服务，支持 WebTracking 和 AK 模式。 |
| HTTP | 批量 POST 到自定义服务端。 |
| OTLP Trace | 将 GenAI 活动导出为 OpenTelemetry Trace。 |

Pilot 会对所有支持的 Agent 输出统一的 GenAI 事件 Schema。字段说明见 [输出事件 Schema](docs/zh-CN/output-event-schema.md)。

## 运行和运维

安装后可以使用 `loongsuite-pilot` 命令：

```bash
loongsuite-pilot start
loongsuite-pilot stop
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot rollback
```

可选本地 Dashboard：

```bash
loongsuite-pilot monitor start
```

然后打开 `http://127.0.0.1:8765/`。

## 文档

[用户手册](docs/zh-CN/README.md) - 安装、配置、运行和扩展 Pilot 的完整入口

[安装指南](docs/zh-CN/installation.md) - 安装、验证服务、卸载和源码运行

[配置参考](docs/zh-CN/configuration.md) - 全局配置加载、运行开关、保留策略和配置入口

[输出 Schema](docs/zh-CN/output-event-schema.md) - 标准事件名称、字段、Provider 和结束原因

[开发者指南](docs/zh-CN/agent-onboarding.md) - 为新的 AI Coding Agent 增加采集支持

## 从源码构建

```bash
git clone https://github.com/loongsuite/loongsuite-pilot.git
cd loongsuite-pilot
npm install
npm run build
node scripts/postinstall.js
node dist/index.js
```

本地开发：

```bash
npm install
npm run build
npm run typecheck
npm test
```

如需从本地构建包安装为后台服务，请参考 [安装指南](docs/zh-CN/installation.md)。

## 许可证

Apache License 2.0 - 详见 [LICENSE](LICENSE)。
