# loongsuite-pilot 项目导航

> 多 AI Agent 轻量数据采集平台 — 自动发现、多种采集方式、多目标数据输出

## 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                         Orchestrator                              │
│                    (启动编排 / 生命周期管理)                         │
├─────────────┬─────────────┬───────────────┬──────────────────────┤
│  Discovery  │  Deployment │    Input      │      Output          │
│  发现 Agent  │  部署采集能力 │  数据采集      │     数据输出          │
├─────────────┼─────────────┼───────────────┼──────────────────────┤
│ AgentDiscov │ Deployment  │ InputManager  │ MultiFlusher         │
│ eryService  │ Manager     │              │  ├─ SlsFlusher        │
│             │ AgentDef    │ BaseIdeInput  │  ├─ JsonlFlusher     │
│ AgentContro │ Loader      │ BaseSqlite..  │  ├─ HttpFlusher      │
│ lManager    │ HookStrategy│ BaseHookInput │  └─ OtlpTraceFlusher │
│             │ PluginProbe │ BaseSession.. │                      │
│             │ Strategy    │ BaseCliForw.. │                      │
├─────────────┴─────────────┴───────────────┴──────────────────────┤
│  File Collection (独立文件采集管道)                                │
│  FileCollectionManager → N × FilePipeline (FileTailer + SlsSender)│
├──────────────────────────────────────────────────────────────────┤
│  Checkpoint (StateStore / SnapshotStore)  │  Updater (自动更新)    │
└──────────────────────────────────────────┴───────────────────────┘
```

## 模块清单

| 模块 | 路径 | 职责 | 详细文档 |
|------|------|------|---------|
| 核心编排 | `src/core/` | 启动流程、生命周期、Agent 发现与准入控制 | [产品概览](docs/zh-CN/overview.md) |
| 输入源 | `src/inputs/` | 6 种采集基类 + 各 Agent 实现 | [新 Agent 接入](docs/zh-CN/agent-onboarding.md) |
| 数据输出 | `src/flushers/` | SLS / JSONL / HTTP 多目标扇出 | [配置指南](docs/zh-CN/configuration.md) |
| 文件采集 | `src/file-collection/` | 本地文件采集 → SLS 独立管道 | [SLS 输出](docs/zh-CN/sls-output.md) |
| 部署管理 | `src/deployment/` | 声明式 Agent 部署（Hook / Plugin-Probe） | [Agent 定义](docs/zh-CN/agent-onboarding.md#agent-定义) |
| 归一化 | `src/normalization/` | 原始数据 → AgentActivityEntry 标准格式 | [输出事件 Schema](docs/zh-CN/output-event-schema.md) |
| 持久化 | `src/checkpoints/` | StateStore + SnapshotStore 状态管理 | [临时异常下的 Checkpoint](docs/zh-CN/agent-onboarding.md#临时异常下的-checkpoint) |
| 自动更新 | `src/updater/` | 多版本管理、增量更新、灰度发布、自动回滚 | [安装与服务管理](docs/zh-CN/installation.md) |
| 运行时 | `deploy/` | 安装、CLI、服务管理、版本指针 | [安装与服务管理](docs/zh-CN/installation.md) |
| 本地 Dashboard | `src/dashboard/` + `src/status-bar/metrics-summary-writer.ts` | 默认随主进程启停的本地页面；生成并展示 `metrics-summary.json` 汇总 | [安装与服务管理](docs/zh-CN/installation.md) |
| 类型定义 | `src/types/` | ClientType、事件结构、配置类型 | [输出事件 Schema](docs/zh-CN/output-event-schema.md) |

## Agent 采集矩阵

| Agent | ID | 部署模式 | 采集基类 | Input 实现 | 声明文件 |
|-------|----|---------|---------|-----------|---------|
| Qoder IDE | `qoder` | Hook | `BaseIdeInput` | `inputs/qoder/` | `agents.d/qoder.json` |
| Qoder CN | `qoder-cn` | Hook | `BaseIdeInput` / `BaseSqliteInput` | `inputs/qoder-cn*/` | `agents.d/qoder-cn.json` |
| Qoder for JetBrains | `qoder-jetbrains` | Detection-only（复用 Qoder 采集） | 复用 Qoder Input | `inputs/qoder*/` | `agents.d/qoder-jetbrains.json` |
| Qoder Work | `qoder-work` | Hook | `BaseSqliteInput` / `BaseHookInput` | `inputs/qoder-work*/` | `agents.d/qoder-work.json` |
| Qoder Work CN | `qoder-work-cn` | Hook | `BaseHookInput` / `BaseSessionInput` | `inputs/qoder-work*/` | `agents.d/qoder-work-cn.json` |
| Qoder CLI | `qoder` | Hook | `BaseInput`（qoder-trace 单路：合并 Hook JSONL + native session 片段 + SQLite token） | `inputs/qoder-trace/` | `agents.d/qoder.json` |
| Cursor | `cursor` | Hook | `BaseHookInput` | `inputs/cursor-hook/` | `agents.d/cursor.json` |
| Cursor CLI | `cursor-cli` | 复用 Cursor Hook | `BaseHookInput` | `inputs/cursor-hook/` | `agents.d/cursor-cli.json` |
| Claude Code | `claude-code` | Hook | `BaseHookInput` | `inputs/claude-code-log/` | `agents.d/claude-code.json` |
| Codex | `codex` | Hook | `BaseInput` | `inputs/codex-transcript/` | `agents.d/codex.json` |
| DeepSeek Harness | `dsh` | DSH YAML Patch | `BaseSessionInput` | `inputs/dsh-log/` | `agents.d/dsh.json` |
| Kiro CLI | `kiro-cli` | Hook | `BaseHookInput` / `BaseInput` | `inputs/kiro-cli-*/` | `agents.d/kiro-cli.json` |
| OpenCode | `opencode` | Plugin-Inject | `BaseHookInput` | `inputs/opencode-log/` | `agents.d/opencode.json` |
| MiMo Code | `mimo-code` | Plugin-Inject | `BaseHookInput` | `inputs/mimo-code-log/` | `agents.d/mimo-code.json` |
| Hermes Agent | `hermes-agent` | Directory-Plugin | `BaseSessionInput` | `inputs/hermes-log/` | `agents.d/hermes-agent.json` |
| OpenClaw | `openclaw` | Plugin-Inject | `BaseHookInput` | `inputs/openclaw-plugin/` | `agents.d/openclaw.json` |
| Pi Coding Agent | `pi-coding-agent` | Plugin-Inject（Extension） | `BaseHookInput` | `inputs/pi-coding-agent-log/` | `agents.d/pi-coding-agent.json` |
| Qwen Code CLI | `qwen-code-cli` | Hook | `BaseHookInput` | `inputs/qwen-code-cli-log/` | `agents.d/qwen-code-cli.json` |
| WorkBuddy | `workbuddy` | Hook | `BaseInput`（Hook/文件唤醒 + 本地 transcript 30 秒轮询兜底） | `inputs/workbuddy/` | `agents.d/workbuddy.json` |
| Wukong | `wukong` | CLI API Polling | `BaseInput` | `inputs/wukong/` | N/A |

## 依赖关系

```
agents.d/*.json ──声明──→ DeploymentManager ──部署──→ Hook / Plugin
                                                         │
                                                         ▼ (产生数据)
AgentDiscoveryService ──发现──→ InputManager ──注册──→ Input 实例
                                                         │
                                                         ▼ (采集事件)
                              EntryBuilder ──归一化──→ AgentActivityEntry
                                                         │
                                                         ▼ (输出)
                              MultiFlusher ──扇出──→ SLS / JSONL / HTTP / OTLP Trace
```

**模块间依赖**：
- `core/orchestrator` → 依赖所有子模块，是唯一顶层入口
- `inputs/*` → 依赖 `checkpoints/`（状态持久化）、`normalization/`（格式转换）
- `deployment/` → 依赖 `agents.d/*.json`（声明文件）、`assets/hooks/`（Hook 脚本）
- `flushers/` → 无内部依赖，仅依赖配置

## 测试资源索引

| 类型 | 路径 | 说明 |
|------|------|------|
| 单元测试 | `tests/unit/` | 按模块对应（core / inputs / flushers / deployment / ...） |
| 契约测试 | `tests/contract/` | 输入输出格式验证 |
| 集成测试 | `tests/integration/` | 跨模块协作测试 |
| E2E 远程测试 | `tests/e2e-remote/` | 远程开发机场景 |
| 性能测试 | `tests/performance/` | 采集吞吐和延迟基准 |
| 测试夹具 | `tests/fixtures/` | Mock 数据和预置文件 |
| 测试辅助 | `tests/helpers/` | 共享测试工具函数 |
| 最终安装态验收 | [新 Agent 接入：安装产物最终验收](docs/zh-CN/agent-onboarding.md#安装产物最终验收) | 真实 Agent、严格 JSONL validator 与字段质量验收 |

## 本地基础设施

| 路径 | 用途 |
|------|------|
| `~/.loongsuite-pilot/` | 数据根目录 |
| `~/.loongsuite-pilot/config.json` | 用户配置文件 |
| `~/.loongsuite-pilot/configs/inner/data_config.json` | 集团版内置 SLS 配置（仅集团版） |
| `~/.loongsuite-pilot/agent-control.json` | 准入控制策略 |
| `~/.loongsuite-pilot/deployed-agents.json` | 部署状态记录 |
| `~/.loongsuite-pilot/hooks/` | 已部署的 Hook 脚本 |
| `~/.loongsuite-pilot/plugins/` | 已安装的 OTel 插件 |
| `~/.loongsuite-pilot/logs/output/` | JSONL 采集输出 |
| `~/.loongsuite-pilot/logs/input-state.json` | 输入源偏移状态 |
| `~/.loongsuite-pilot/logs/snapshot-store.json` | 快照去重状态 |
| `~/.loongsuite-pilot/logs/otlp-debug/` | OTLP trace debug 落盘 |
| `~/.loongsuite-pilot/logs/otlp-failed/` | OTLP trace 失败持久化 |
| `~/.loongsuite-pilot/versions/` | 多版本安装目录 |
| `~/.loongsuite-pilot/current` | 当前版本指针 |

## 快速入口

- **我要理解整体架构** → [docs/zh-CN/overview.md](docs/zh-CN/overview.md)
- **我要接入新 Agent** → [docs/zh-CN/agent-onboarding.md](docs/zh-CN/agent-onboarding.md)
- **我要设计 transcript + Hook 混合采集、时间边界或 checkpoint** → [docs/zh-CN/agent-onboarding.md#可靠的混合采集](docs/zh-CN/agent-onboarding.md#可靠的混合采集)
- **我要理解数据流** → [docs/zh-CN/overview.md#采集的数据](docs/zh-CN/overview.md#采集的数据) + [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
- **我要配置输出通道** → [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md)
- **我要了解部署运维** → [README.md](README.md)（打包/安装/升级/卸载）
- **我要了解数据 Schema** → [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
