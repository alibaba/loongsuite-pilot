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
| 核心编排 | `src/core/` | 启动流程、生命周期、Agent 发现与准入控制 | [docs/modules/core.md](docs/modules/core.md) |
| 输入源 | `src/inputs/` | 6 种采集基类 + 各 Agent 实现 | [docs/modules/inputs.md](docs/modules/inputs.md) |
| 数据输出 | `src/flushers/` | SLS / JSONL / HTTP 多目标扇出 | [docs/modules/flushers.md](docs/modules/flushers.md) |
| 文件采集 | `src/file-collection/` | 本地文件采集 → SLS 独立管道 | [docs/modules/file-collection.md](docs/modules/file-collection.md) |
| 部署管理 | `src/deployment/` | 声明式 Agent 部署（Hook / Plugin-Probe） | [docs/modules/hooks.md](docs/modules/hooks.md) |
| 归一化 | `src/normalization/` | 原始数据 → AgentActivityEntry 标准格式 | [docs/modules/normalization.md](docs/modules/normalization.md) |
| 持久化 | `src/checkpoints/` | StateStore + SnapshotStore 状态管理 | [docs/modules/checkpoints.md](docs/modules/checkpoints.md) |
| 自动更新 | `src/updater/` | 多版本管理、增量更新、灰度发布、自动回滚 | [docs/modules/updater.md](docs/modules/updater.md) |
| 运行时 | `deploy/` | 安装、CLI、服务管理、版本指针 | [docs/modules/runtime.md](docs/modules/runtime.md) |
| 监控 | `src/internal/` | 本地 dashboard、进程采样、健康状态 | [docs/modules/monitor.md](docs/modules/monitor.md) |
| 类型定义 | `src/types/` | ClientType、事件结构、配置类型 | [docs/modules/types.md](docs/modules/types.md) |

## Agent 采集矩阵

| Agent | ID | 部署模式 | 采集基类 | Input 实现 | 声明文件 |
|-------|----|---------|---------|-----------|---------|
| Qoder IDE | `qoder` | Hook | `BaseIdeInput` | `inputs/qoder/` | `agents.d/qoder.json` |
| Qoder Work | `qoder-work` | Hook | `BaseSqliteInput` / `BaseHookInput` | `inputs/qoder-work*/` | `agents.d/qoder-work.json` |
| Qoder CLI | `qoder` | Hook | `BaseHookInput` / `BaseSessionInput` | `inputs/qoder-cli*/` | `agents.d/qoder.json` |
| Cursor | `cursor` | Hook | `BaseHookInput` | `inputs/cursor-hook/` | `agents.d/cursor.json` |
| Claude Code | `claude-code` | Plugin-Probe | `BaseHookInput` | `inputs/claude-code-log/` | `agents.d/claude-code.json` |
| Codex | `codex` | Plugin-Probe | `BaseHookInput` | `inputs/codex-log/` | `agents.d/codex.json` |
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
| 远程 E2E 指南 | [docs/E2E-REMOTE-TEST-GUIDE.md](docs/E2E-REMOTE-TEST-GUIDE.md) | 远程机器测试操作手册 |

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

- **我要理解整体架构** → [docs/constitution.md](docs/constitution.md)
- **我要接入新 Agent** → [docs/agent-onboarding-guide.md](docs/agent-onboarding-guide.md) + [docs/modules/hooks.md](docs/modules/hooks.md)
- **我要理解数据流** → [docs/modules/core.md](docs/modules/core.md) + [docs/modules/inputs.md](docs/modules/inputs.md)
- **我要新增输出通道** → [docs/modules/flushers.md](docs/modules/flushers.md)
- **我要了解部署运维** → [README.md](README.md)（打包/安装/升级/卸载）
- **我要了解数据 Schema** → [docs/ai_event_schema.md](docs/ai_event_schema.md)
