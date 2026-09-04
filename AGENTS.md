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
| `~/.loongsuite-pilot/logs/last-restart-failure-{collector,updater}.json` | 服务管理脚本留下的重启失败面包屑，node 侧读来富化告警（文件还在 = 上次失败） |
| `~/.loongsuite-pilot/versions/` | 多版本安装目录 |
| `~/.loongsuite-pilot/current` | 当前版本指针 |

## `restart-collector` / `restart-updater` 不许无声失败

线上唯一能看到的东西曾经是这一行，没有任何原因：

```
Cmd-RestartUpdater : Service manager failed to restart updater (init_type=taskscheduler)
```

三条独立的原因把信息全吃掉了：① 原因都在 `Write-Host`，而调用方用 `execFile`，`err.message` **只带
stderr**，stdout 整个被丢掉；② 脚本头部 `$ErrorActionPreference = "Stop"` 让 `Write-Error` 变成**终止
错误**，写在它之后的诊断（包括当年那句 `return`）是死代码；③ 有些分支一个字都不打印（`Get-TaskExists`
把"任务不存在"和"`Get-ScheduledTask` 自己报错"折叠成同一个 `$false`，见 `windows-scheduledtasks-autoload-gap`）。
外加一个行为缺陷：自愈分支被 `init_type` 门禁挡在 `background|unknown|""` 之外，`taskscheduler` 装机上
任务一坏就**永远**只能走到那句 `Write-Error`，每个周期重演一次。

现在的契约，`.ps1` 与 `.sh` 对称：

- 每个非成功出口先 `Write-RestartFailure` / `write_restart_failure` 命名一个 **stage**，再退出；
  **顺序是承重的**（EAP=Stop 下 `Write-Error` 之后的代码不可达）。
- stage 标签是 `src/utils/restart-breadcrumb.ts` 的 `RESTART_STAGES`，两侧逐字相同、永不本地化 ——
  它们是告警流里的聚合键，只有一侧认识的标签等于告警查不出来。
- 面包屑落在 `logs/last-restart-failure-<target>.json`（`schema: 1`，扁平 `diag`），语义同
  `crash-breadcrumb`：**文件还在就代表上一次失败**，所以两个命令入口都先清掉它。诊断走文件而不是流，
  因为流不可靠（`$OutputEncoding` 是 ASCII、EAP=Stop 会改写流、安装器里的 `Restart-StaleCollector`
  还会 `2>&1` 合流）。
- node 侧读的时候**校验新鲜度**（`ts >= attemptStart - 5s`）：脚本压根没跑起来（`powershell.exe` 不在、
  子进程被 kill）时，不能拿上一次留下的文件冒充这次的原因。超时被 kill 单独记成 `stage=timeout`。
- 告警**复用现有类型**（`UPDATER_FAILURE_ALARM` / `SERVICE_NOT_RUNNING_ALARM`），只富化
  `alarm_message`：`... | stage=<s> reason="<detail>" init_type=<t> task_state=<s> ...`。event schema
  和下游 SLS 配置不动。
- 启动确认是**有界轮询**（`Wait-ForUpdaterAlive` / `wait_for_updater_process`），不是 `Start-Sleep 1`
  加一次探测 —— 一秒不够 `wscript.exe` → node 落 pid 文件，而这个误判在 `init_type=taskscheduler` 上是
  终局判决。node 侧的命令超时因此提到 90s：30s 会在脚本诊断到一半时把它杀掉，亲手毁掉证据。
- 自愈不再看 `init_type`；但 background/nohup 兜底**仍然**只对 `background|unknown|""` 开放（托管装机上
  它不是修复，是一个游离于服务管理器之外、会在下次注销时死掉的第二个 daemon），跳过时要上报，不许静默。

| 测试 | 约束 |
|------|------|
| `tests/unit/scripts/ps1-restart-diagnostics.test.mjs` | `.ps1`：每个 `Write-Error` 之前都有 `Write-RestartFailure`；两个入口都先 `Clear-RestartFailure`；每个 `Start-ScheduledTask` 后面跟着等待；自愈块不提 `$initType` 而兜底仍然门禁；写文件带 `-Encoding UTF8` + `Move-Item`；诊断只读（不碰会删 pid 文件的 `Test-PidRunning`）；`schtasks` 交叉校验保持 prevEAP/`2>&1`/`$LASTEXITCODE` 那套写法 |
| `tests/unit/scripts/sh-restart-diagnostics.test.mjs` | `.sh` 对称版，外加 `set -euo pipefail` 的两个坑（可能空手而归的探针必须自己 `\|\| true`）、手写 JSON 的每个插值都过 `json_escape`、面包屑路径与 node 侧 `restartFailurePath()` 对齐 |
| `tests/unit/scripts/ps1-restart-best-effort.test.mjs` | 被拒的重新注册不许跳过 `Start-ScheduledTask`（两个独立 try） |
| `tests/unit/utils/restart-breadcrumb.test.ts` | 带 BOM 能读、未知 schema/截断文件返回 null、新鲜度窗口、摘要长度预算与引号换行清洗 |

## 快速入口

- **我要理解整体架构** → [docs/zh-CN/overview.md](docs/zh-CN/overview.md)
- **我要接入新 Agent** → [docs/zh-CN/agent-onboarding.md](docs/zh-CN/agent-onboarding.md)
- **我要设计 transcript + Hook 混合采集、时间边界或 checkpoint** → [docs/zh-CN/agent-onboarding.md#可靠的混合采集](docs/zh-CN/agent-onboarding.md#可靠的混合采集)
- **我要理解数据流** → [docs/zh-CN/overview.md#采集的数据](docs/zh-CN/overview.md#采集的数据) + [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
- **我要配置输出通道** → [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md)
- **我要了解部署运维** → [README.md](README.md)（打包/安装/升级/卸载）
- **我要了解数据 Schema** → [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
