# LoongSuite Pilot

[English](README.md) | 简体中文

[快速开始](#快速开始) | [文档](#文档) | [新 Agent 接入](docs/zh-CN/agent-onboarding.md) | [许可证](#许可证)

LoongSuite Pilot 是一个运行在开发者本机的 AI Coding Agent 遥测采集器。它可以发现本机已安装的支持 Agent，部署所需的 Hook 或插件，将不同 Agent 的活动数据归一化为统一的 GenAI 事件 Schema，并输出到本地日志、SLS、HTTP 或 Trace 后端。

<p align="center">
  <img src="docs/_assets/img/dashboard.png" alt="LoongSuite Pilot 本地 Dashboard" width="880">
  <br>
  <em>本地 Dashboard —— 一眼掌握多 Agent 采集状态、Token 用量与上报健康度。</em>
</p>

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
| Kiro CLI | Hook / session 轮询 | Yes | Yes | No | Yes |
| OpenCode | 插件注入 | Yes | Yes | Yes | Yes |
| Qoder | Hook | Yes | Yes | Yes | Yes |
| Qoder CN | Hook | Yes | Yes | Yes | Yes |
| Qoder for JetBrains | 自动检测 | Yes | Yes | Yes | Yes |
| Qoder CLI | Hook / session polling | Yes | Yes | Yes | Yes |
| Qoder Work | Hook / 本地数据轮询 | Yes | Yes | Yes | Yes |
| Qoder Work CN | Hook / 本地数据轮询 | Yes | Yes | Yes | Yes |
| Qwen Code CLI | Hook | Yes | Yes | Yes | Yes |
| Wukong | CLI API 轮询 | Yes | Yes | Yes | Yes |

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

### 上游 Trace 串联(可选)

把采集到的 agent span 挂到**上游** trace 下,使每一轮的 span 树重挂到上游 span。默认关闭,且全程 fail-open(绝不影响正常采集/上报)。

| 配置项 | 取值 | 默认 |
| ------ | ---- | ---- |
| `LOONGSUITE_PILOT_UPSTREAM_LINK`(环境变量)· `upstreamLink.enabled`(config.json) | `true` / `1` 开启;不设、`false` 或 `0` 关闭 | 关闭 |
| `LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS`(环境变量)· `upstreamLink.ttlMs`(config.json) | `acp-correlate` 文件清理 TTL(毫秒) | `86400000`(24 小时) |

开启后,上游 `traceparent` 经以下两种方案之一到达 Pilot,并在采集时 stamp 到记录(turn 打 `trace_id`、用户输入事件打 `parent_span_id`):

- **关联文件**(per-turn):调用方在发送 prompt 时,把 `{sessionId, contentHash, contentPrefix, traceparent}` 写入 `~/.loongsuite-pilot/acp-correlate/<sessionId>.jsonl`。串联与协议无关——唯一要求是 `sessionId` 等于 Pilot 采集该 turn 时的 `gen_ai.session.id`,且内容(hash 或前缀)能匹配采集到的用户文本。ACP client 天然满足(`session/new` 的 id 会贯穿采集),故 ACP 是主要场景。
- **环境变量**(agent 进程上的 `TRACEPARENT`):经 agent 的 hook 作用于该会话的第一个 turn。适用于调用方无法预先拿到 per-turn `sessionId` 的情况。

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
loongsuite-pilot token-usage
loongsuite-pilot rollback
```

可选本地 Dashboard：

```bash
loongsuite-pilot monitor start
```

然后打开 `http://127.0.0.1:8765/`。

macOS 菜单栏 App：

在 macOS 上，Pilot 安装完成后会自动常驻菜单栏，无需额外命令。它实时展示 Token、会话、请求、工具调用数量，以及按 Agent 和 Provider 的分布，让你不用打开 Dashboard 也能随时掌握活动情况。

<p align="center">
  <img src="docs/_assets/img/menubar.jpg" alt="LoongSuite Pilot macOS 菜单栏 App" width="360">
</p>

如需关闭，设置环境变量 `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP=false`，或在 `~/.loongsuite-pilot/config.json` 中加入 `"enableStatusBarApp": false`。

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

## 社区

欢迎反馈和建议，扫描下方二维码加入 LoongSuite Pilot 钉钉交流群。

| LoongSuite Pilot SIG |
|----|
| <img src="docs/_assets/img/loongsuite-pilot-sig-dingtalk.jpg" height="150"> |

### 相关项目

- [LoongCollector](https://github.com/alibaba/loongcollector) - 通用节点 Agent，提供日志采集、Prometheus 指标采集和基于 eBPF 的网络/安全采集
- [LoongSuite JS](https://github.com/alibaba/loongsuite-js) - 面向 JS 系 AI Coding Agent 的 OpenTelemetry 可观测插件
- [LoongSuite Python](https://github.com/alibaba/loongsuite-python) - Python 应用进程 Agent
- [LoongSuite Go](https://github.com/alibaba/loongsuite-go) - Golang 编译期注入进程 Agent
- [LoongSuite Java](https://github.com/alibaba/loongsuite-java) - Java GenAI 遥测工具库

## 许可证

Apache License 2.0 - 详见 [LICENSE](LICENSE)。
