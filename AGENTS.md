# loongsuite-pilot 项目导航

> 多 AI Agent 轻量数据采集平台 — 自动发现、多种采集方式、多目标数据输出

## 内部仓库补充

- **我要本地调试** → [specs/local-e2e-testing-guide.md](specs/local-e2e-testing-guide.md)
- **我要远程 E2E** → [docs/E2E-REMOTE-TEST-GUIDE.md](docs/E2E-REMOTE-TEST-GUIDE.md)

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
| 监控 | `src/internal/` | 本地 dashboard、进程采样、健康状态 | [本地运行目录](docs/zh-CN/overview.md#本地运行目录) |
| 类型定义 | `src/types/` | ClientType、事件结构、配置类型 | [输出事件 Schema](docs/zh-CN/output-event-schema.md) |

## Agent 采集矩阵

| Agent | ID | 部署模式 | 采集基类 | Input 实现 | 声明文件 |
|-------|----|---------|---------|-----------|---------|
| Qoder IDE | `qoder` | Hook | `BaseIdeInput` | `inputs/qoder/` | `agents.d/qoder.json` |
| Qoder CN | `qoder-cn` | Hook | `BaseIdeInput` / `BaseSqliteInput` | `inputs/qoder-cn*/` | `agents.d/qoder-cn.json` |
| Qoder for JetBrains | `qoder-jetbrains` | Detection-only（复用 Qoder 采集） | 复用 Qoder Input | `inputs/qoder*/` | `agents.d/qoder-jetbrains.json` |
| Qoder Work | `qoder-work` | Hook | `BaseSqliteInput` / `BaseHookInput` | `inputs/qoder-work*/` | `agents.d/qoder-work.json` |
| Qoder Work CN | `qoder-work-cn` | Hook | `BaseHookInput` / `BaseSessionInput` | `inputs/qoder-work*/` | `agents.d/qoder-work-cn.json` |
| Qoder CLI | `qoder` | Hook | `BaseHookInput` / `BaseSessionInput` | `inputs/qoder-cli*/` | `agents.d/qoder.json` |
| Cursor | `cursor` | Hook | `BaseHookInput` | `inputs/cursor-hook/` | `agents.d/cursor.json` |
| Cursor CLI | `cursor-cli` | 复用 Cursor Hook | `BaseHookInput` | `inputs/cursor-hook/` | `agents.d/cursor-cli.json` |
| Claude Code | `claude-code` | Hook | `BaseHookInput` | `inputs/claude-code-log/` | `agents.d/claude-code.json` |
| Codex | `codex` | Hook | `BaseInput` | `inputs/codex-transcript/` | `agents.d/codex.json` |
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

## PowerShell (.ps1) 硬约束

仓库里所有 `.ps1`（安装器、CLI 包装、`assets/hooks/*.ps1`）都在用户机器上运行，其中一部分机器启用了
WDAC / AppLocker 应用控制策略 —— 策略不放行的脚本会以 **ConstrainedLanguage 模式（CLM）** 执行。
因此**新增或修改任何 `.ps1` 都必须满足下面两条硬约束**，不是建议：

**1) CLM-safe**

- 只有「允许类型」可以被强制转换、可以调用其方法；其他 .NET 类型的**方法调用**一律抛异常。
  静态**属性读取**（如 `[Console]::IsInputRedirected`）不受限制，任何类型都允许。
- 安装器与 hook 大量使用 `$ErrorActionPreference = "Stop"` + fail-open 的 `catch`，
  所以一次 CLM 违规的表象不是报错，而是**静默失败**（安装中断在错误的分支 / 遥测悄悄丢失）。
- 常见坑 → CLM-safe 写法：

  | 禁止 | 替代 |
  |------|------|
  | `[System.IO.Path]::GetFileName()` | `Split-Path -Leaf` |
  | `[System.IO.Path]::IsPathRooted()` | 对路径字符串 `-match` |
  | `[System.IO.Path]::HasExtension()` | `$p -match '\.[^\\/.]+$'` |
  | `[System.IO.Path]::GetTempPath()` | `$env:TEMP` |
  | `[System.IO.File]::ReadAllText/WriteAllText` | `Get-Content` / `Set-Content` |
  | `[System.IO.Directory]::Exists/Delete` | `Test-Path` / `Remove-Item` |
  | `[Environment]::UserName` | `$env:USERNAME` |
  | `$x.PSObject.Properties.Remove(k)` | `Select-Object -Property * -ExcludeProperty k` |
  | `$PSBoundParameters.ContainsKey(k)` | `$PSBoundParameters.Keys -contains k` |
  | `[Convert]` / `[Math]` / `[regex]::Matches` / `[Text.Encoding]` / `[Security.Cryptography]` | 用语言操作符或 cmdlet 表达 |
  | `New-Object` / `Add-Type` / `Invoke-Expression` / `class` / `enum` / `[ref]` | 无替代，禁止 |

- 结构化数据只用 `[hashtable]`。**`[pscustomobject]@{...}` 和 `[ordered]@{...}` 都禁止**：
  `about_Language_Modes` 的允许类型清单**不等于** Windows PowerShell 5.1 真实的 CoreTypes 白名单，
  文档把 `[pscustomobject]` 列为允许，但 5.1 在 WDAC 下实测抛 `ConversionSupportedOnlyToCoreTypes`
  （加速器真实转换目标是内部类型 `LanguagePrimitives+InternalPSCustomObject`）。**清单不可信，只信实测。**
- 确实无替代且失败可降级时，整段包进 `try { } catch { }` 并从 catch 返回 CLM-safe 默认值，
  同时在注释里写明降级语义。
- 完整论证（含每条规则的由来）在 `deploy/installer.ps1` 文件头的 CLM 区块，那是**唯一权威副本**；
  其他 `.ps1` 不再重复这段说明，只在具体改写点写一行「为什么不用那个 API」。

**2) 注释全 ASCII**

`.ps1` 注释一律英文 ASCII，连 em dash / 箭头 / 中文引号 / emoji 都不要。`Msg` 之类**输出文案**里的中文保留。
原因：BOM 一丢（复制粘贴、工具重写、CRLF 转换）5.1 就按系统 ANSI 代码页（中文 Windows 是 GBK/936）解析脚本；
文档推荐的 `irm <URL>/installer.ps1 | iex` 更是按 HTTP charset 解码、完全不看 BOM。乱码字节可能带出引号/反引号
把解析器一起拖崩。

**3) 编码**

`Set-Content` / `Add-Content` / `Get-Content` 在 5.1 默认走 ANSI 代码页。凡是与 node 侧交换的文件
（`deployed-agents.json`、插件 marker 等）读写都要显式 `-Encoding UTF8`。注意 5.1 没有 `utf8NoBOM`，
`-Encoding UTF8` 必定写出 BOM —— node 侧 `readJsonFile()` 已剥离前导 BOM，缺了这一步 `JSON.parse` 会抛、
被 `catch` 吞掉返回 `null`，部署状态会**静默重置为空**。

**兜底（不靠人自觉）**

| 测试 | 约束 |
|------|------|
| `tests/unit/deploy/installer-ps1-clm-safe.test.mjs` | 内部专有 `.ps1`（`deploy/installer{,-inner}.ps1`、`ensure-pilot.ps1`）的 CLM + ASCII ratchet；禁止上表的写法；静态成员访问走审计过的白名单；权威 CLM 区块必须在 `deploy/installer{,-inner}.ps1` |
| `tests/unit/scripts/ps1-clm-safe.test.mjs` | 全仓库 CLM ratchet，`KNOWN_CLM_UNSAFE` 白名单只能缩不能扩 |
| `tests/unit/scripts/ps1-comments-ascii.test.mjs` | 全仓库 ASCII ratchet，`KNOWN_UNCONVERTED` 白名单只能缩不能扩 |
| `tests/unit/scripts/ps1-json-encoding.test.mjs` | 所有 `Get-Content \| ConvertFrom-Json` / `ConvertTo-Json \| Set-Content` 必须带 `-Encoding UTF8` |
| `tests/unit/utils/fs-utils.test.ts` | node 侧 `readJsonFile()` 必须剥离前导 BOM（与上一条成对，只修一半比不修更糟） |

`tests/unit/scripts/*` 与 `tests/unit/utils/*` 这几条住在开源仓（`alibaba/loongsuite-pilot`），
经开源同步落到本仓；它们都用 `git ls-files '*.ps1'` 扫描，所以同步之后连内部专有 `.ps1` 一起覆盖。
第一条则常驻本仓：安装器只存在于内部，且要在同步到位之前就把内部文件钉住。

## 快速入口

- **我要理解整体架构** → [docs/zh-CN/overview.md](docs/zh-CN/overview.md)
- **我要接入新 Agent** → [docs/zh-CN/agent-onboarding.md](docs/zh-CN/agent-onboarding.md)
- **我要设计 transcript + Hook 混合采集、时间边界或 checkpoint** → [docs/zh-CN/agent-onboarding.md#可靠的混合采集](docs/zh-CN/agent-onboarding.md#可靠的混合采集)
- **我要理解数据流** → [docs/zh-CN/overview.md#采集的数据](docs/zh-CN/overview.md#采集的数据) + [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
- **我要配置输出通道** → [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md)
- **我要了解部署运维** → [README.md](README.md)（打包/安装/升级/卸载）
- **我要了解数据 Schema** → [docs/zh-CN/output-event-schema.md](docs/zh-CN/output-event-schema.md)
