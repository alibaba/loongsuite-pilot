# pilot 服务诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/service-diagnostics.md`，随 pilot 升级自动更新。

覆盖 **pilot 服务自身的运行状态排查**——服务启动失败、崩溃、Input 未注册、日志异常等问题。
不覆盖单个 agent 的 hook/JSONL 链路问题（那些请查阅对应的 agent 分诊文档）。

---

## 日志格式说明

pilot 服务日志采用 [pino](https://github.com/pinojs/pino) JSON 格式输出，每行一个 JSON 对象。关键字段：

| 字段 | 含义 |
|------|------|
| `level` | 日志级别：`DEBUG` / `INFO` / `WARN` / `ERROR` |
| `time` | ISO 8601 时间戳 |
| `tag` | 日志来源模块，如 `Orchestrator`、`SlsFlusher`、`HookWatchdog` |
| `msg` | 日志消息正文 |

日志文件自动按天轮转，单文件上限 50MB。默认日志级别为 `INFO`，可通过环境变量 `LOG_LEVEL=debug` 降级。

---

## 系统化排查顺序

> **前提**：进入本文档前，应已通过 `diagnostics.md` 的通用前置检查确认 pilot 服务正在运行。

pilot 服务出现异常时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → 服务日志中的启动序列是否完整
第 2 步 → Input 注册与 agent 发现状态
第 3 步 → Flusher 初始化状态
第 4 步 → 后台守护服务状态（LogRetention + HookWatchdog）
```

---

## 第 1 步：服务启动序列

Orchestrator 启动按固定顺序执行 9 个步骤。在服务日志中搜索 `tag: Orchestrator` 可以定位到卡在哪一步：

| 步骤 | 日志关键字 | 含义 |
|------|-----------|------|
| 1 | `starting orchestrator` | 启动开始 |
| 2 | （StateStore 加载，无显式日志） | 加载 `input-state.json` |
| 3 | （Flusher 构建） | 创建 SLS / JSONL / HTTP flusher |
| 4 | （InputManager 创建，无显式日志） | 构建 Input 管理器 |
| 5 | `cursor hook registered` / `qoder-cli hook registered` / `qoder-work hook registered` | 向 agent 配置文件注入 hook |
| 6 | （Input 注册，见第 3 步排查） | 注册所有 Input |
| 7 | `agent detected and started` / `agent stopped` | AgentDiscoveryService 启动 |
| 8 | `scheduling log retention` | LogRetentionService 启动 |
| 9 | `scheduling hook watchdog` / `hook-watchdog disabled` | PluginHookWatchdog 启动 |
| 完成 | `orchestrator started` + `inputs: N` | 全部就绪，N = 注册的 Input 数量 |

```bash
# 查看最近一次完整启动序列
grep -E '"tag":"(Orchestrator|HookWatchdog|LogRetention)"' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -30
```

预期最终看到 `orchestrator started`。若缺失，说明启动在中间某步失败——找到最后一条 `ERROR` 级日志定位原因。

---

## 第 2 步：Input 注册与 agent 发现状态

pilot 注册 7 个 Input，每个 Input 对应一条数据采集链路：

| Input ID | agentType | 数据源 | 触发条件 |
|----------|-----------|-------|---------|
| `qoder-sqlite` | `qoder` | Qoder IDE SQLite | Qoder DB 文件存在 |
| `qoder-work-hook` | `qoder-work` | Qoder Work hook JSONL | `~/.qoderwork/` 目录存在 |
| `qoder-cli-hook` | `qoder-cli` | Qoder CLI hook JSONL | `~/.qoder/` 目录存在 |
| `qoder-cli-session` | `qoder-cli` | Qoder CLI session segments | `~/.qoder/logs/sessions/` 目录存在 |
| `cursor-hook` | `cursor` | Cursor hook JSONL | `~/.loongsuite-pilot/logs/cursor/history/` 目录存在 |
| `claude-code-log` | `claude-code` | Claude Code OTel JSONL | 日志目录存在 |
| `codex-log` | `codex` | Codex OTel JSONL | 日志目录存在 |

AgentDiscoveryService 通过 fs.watch + 轮询检测 agent 是否可用，满足条件时自动启动对应 Input：

```bash
# 查看哪些 agent 被发现并启动
grep 'agent detected and started\|agent stopped' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20
```

若某个 agent 始终未出现在 `agent detected` 日志中：
- agent 的数据目录不存在（用户从未使用过该工具）
- `config.json` 的 `listeners` 中对应 Input 被 `enabled: false` 关闭

```bash
# 检查 config.json 中是否有显式禁用的 listener
python3 -m json.tool ~/.loongsuite-pilot/config.json 2>/dev/null | grep -A 2 '"enabled"'
```

---

## 第 3 步：Flusher 初始化状态

pilot 支持 3 种 Flusher，可同时启用多个：

| Flusher | 配置位置 | 默认状态 |
|---------|---------|---------|
| **SLS** | `config.json` → `sls` 段 | 有合法 endpoint 时自动启用 |
| **JSONL** | `config.json` → `jsonl` 段 | 默认启用，输出到 `~/.loongsuite-pilot/logs/output/` |
| **HTTP** | `config.json` → `http` 段 | 需显式配置 URL 才启用 |

若所有 Flusher 都未启用，pilot 会自动创建 JSONL fallback：

```bash
# 搜索 flusher 相关日志
grep -i 'flusher\|no flushers' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

预期：至少看到一个 flusher 的启动日志。若看到 `no flushers enabled, using JSONL fallback`，说明 SLS 和 HTTP 都未配置，数据仅写本地 JSONL。

SLS Flusher 的详细排查请阅读 `sls-diagnostics.md`。

---

## 第 4 步：后台守护服务状态

### 5.1 LogRetentionService（日志清理）

自动清理过期日志文件，启动后 30s 首次执行，之后按间隔周期执行（默认 6 小时）。

| 日志类别 | 默认保留天数 | 对应目录 |
|---------|------------|---------|
| hook history | 7 天 | `logs/*/history/` |
| hook errors | 7 天 | `logs/*/errors/` |
| hook debug | 7 天 | `logs/*/debug/` |
| output | 7 天 | `logs/output/` |
| sls-failed-logs | 7 天 | `sls-failed-logs/` |

```bash
# 查看清理日志
grep '"tag":"LogRetention"' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

预期：定期看到 `log retention complete`（即使 deleted=0 也正常）。若看到 `log retention disabled`，检查 `config.json` 的 `retention.enabled` 是否为 `false`。

保留天数可通过 `config.json` 或环境变量 `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` 统一调整。

### 5.2 PluginHookWatchdog（Hook 自动修复）

每 5 分钟（默认）检查 Claude Code（`~/.claude/settings.json`）和 Codex（`~/.codex/hooks.json`）的 hook 注册状态。若发现缺失，自动重跑对应插件的 `install` 命令修复。

```bash
# 查看 watchdog 日志
grep '"tag":"HookWatchdog"' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20
```

| 日志关键字 | 含义 |
|-----------|------|
| `hook-watchdog.check` + `healthy: true` | 检查通过，hook 完整 |
| `hook-watchdog.repair` | 发现缺失 hook，正在修复 |
| `hook-watchdog.repair-ok` | 修复成功 |
| `hook-watchdog.repair-failed` | 修复失败（查看 `exitCode` 和 `stderr`） |
| `hook-watchdog.skipped` + `reason: cooldown` | 在冷却期内跳过（默认冷却 10 分钟） |
| `hook-watchdog.skipped` + `reason: bin-missing` | 插件二进制不存在，跳过该 agent |

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` | 服务运行时日志（pino JSON，daily rotation，50MB 上限） |
| `~/.loongsuite-pilot/logs/input-state.json` | 所有 Input 的增量游标状态 |
| `~/.loongsuite-pilot/config.json` | 主配置文件（三层优先级：环境变量 > config.json > 内置默认） |
| `~/.loongsuite-pilot/agent-control.json` | agent 级别的启用/禁用控制 |
| `~/.loongsuite-pilot/logs/output/` | JSONL Flusher 输出目录 |
| `~/.loongsuite-pilot/sls-failed-logs/` | SLS 上报失败的日志持久化目录 |
| `~/.loongsuite-pilot/node-bin` | 固定的 Node.js 可执行路径（hook 脚本使用） |
| `~/.local/bin/loongsuite-pilot` | CLI 入口脚本 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| 日志中无 `orchestrator started` | 启动在中间步骤失败。搜索最后一条 `ERROR` 日志定位原因。常见：`input-state.json` 损坏、配置文件 JSON 解析失败 |
| 某个 agent 始终未出现在 `agent detected` 日志中 | 1) agent 数据目录不存在（用户未安装/使用该工具）；2) `config.json` 的 `listeners` 中被 `enabled: false` 禁用 |
| `no flushers enabled, using JSONL fallback` | SLS 和 HTTP 都未配置。如需上报 SLS，检查 `sls-diagnostics.md` |
| `input-state.json` 损坏（JSON 解析失败） | 停服 → 备份损坏文件 → 删除 `input-state.json` → 重启服务。所有 Input 会从当前位置重新开始（不会重采历史数据） |
| 日志文件被清理过快 | 调整 `config.json` 的 `retention` 段，增大各类别的保留天数 |
| `hook-watchdog.repair-failed` + `exitCode: 1` | 插件 install 命令失败。查看日志中的 `stderr` 字段。常见原因：Node.js 版本过低、npm 不可用 |
| 日志中大量 `WARN` 级别的 `row transform failed` | 某个 Input 的原始数据格式异常。记录 `rowid` 后检查对应数据源 |
| `LOG_LEVEL=debug` 后日志量过大 | debug 模式仅用于临时排查。排查完毕后移除该环境变量并重启服务 |
