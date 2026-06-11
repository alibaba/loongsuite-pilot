# Module: monitor

> Last verified: 2026-05-13

## 职责 (Responsibility)

本地可选监控层，负责采样 LoongSuite Pilot 进程资源指标，并通过只读 dashboard API 展示 collector/reporting 健康状态。

Monitor 不在采集热路径内运行；关闭 monitor 不影响 collector、hooks、flushers 或 updater。

## 公共接口 (Public Interface)

- **CLI commands** — `loongsuite-pilot monitor start` 同时启动 process monitor 和 dashboard；`loongsuite-pilot monitor stop` 停止二者。
- **Process monitor** (`scripts/monitor-loongsuite-pilot.sh`) — 定期采样 collector 进程的 CPU、内存、线程、文件句柄和网络连接指标，并写入 hourly CSV。
- **Dashboard server** (`scripts/serve-loongsuite-pilot-monitor.mjs`) — 本地 HTTP server，默认监听 `127.0.0.1:8765`。
- **Dashboard UI** (`assets/monitor/loongsuite-pilot-monitor.html`) — 静态 HTML 页面，轮询 dashboard API 展示状态。
- **Overview aggregator** (`scripts/lib/agent-overview.mjs`) — 聚合输出 JSONL、服务日志和 SLS 失败缓存，生成 agent 维度概览。
- **Process metrics reader** (`scripts/lib/process-metrics.mjs`) — 读取 process monitor CSV，提供窗口化指标和状态摘要。

## 内部设计 (Internal Design)

### 进程组成

```
loongsuite-pilot monitor start
    ├── monitor-loongsuite-pilot.sh          # process sampler
    │       └── logs/process-monitor/*.csv
    └── serve-loongsuite-pilot-monitor.mjs   # local dashboard server
            ├── /api/metrics
            ├── /api/status
            ├── /api/overview
            └── /api/overview/agents/:agentId
```

### Process metrics storage

- 输出目录：`~/.loongsuite-pilot/logs/process-monitor/`
- CSV 文件：`loongsuite-pilot-process-YYYY-MM-DD-HH.csv`
- 状态日志：`loongsuite-pilot-monitor.log`
- 默认采样间隔：5 秒
- 默认保留：6 小时

Monitor 通过 PID file 优先定位 collector 进程，找不到时按进程名 pattern 兜底发现。

### Dashboard API

| Endpoint | 数据来源 | 说明 |
|----------|----------|------|
| `GET /` | `assets/monitor/loongsuite-pilot-monitor.html` | 本地 dashboard 页面 |
| `GET /api/metrics` | process monitor CSV | 指标 CSV，支持时间窗口 |
| `GET /api/status` | process monitor CSV metadata | 指标状态摘要 |
| `GET /api/overview` | output JSONL、service logs、SLS failed logs | agent 维度采集/上报概览 |
| `GET /api/overview/agents/:agentId` | overview cache/detail | 单 agent 诊断详情 |

### 运行时配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LOONGSUITE_PILOT_MONITOR_PORT` | `8765` | dashboard 监听端口 |
| `LOONGSUITE_PILOT_MONITOR_HOST` | `127.0.0.1` | dashboard 监听地址 |
| `LOONGSUITE_PILOT_MONITOR_DIR` | `$DATA_DIR/logs/process-monitor` | metrics CSV 目录 |
| `LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES` | `60` | dashboard 指标窗口 |
| `LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS` | `6` | metrics 文件保留小时数 |
| `LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS` | `300` | metrics 清理周期 |

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| runtime | CLI 管理 monitor 进程和 PID 文件 |
| flushers | dashboard 读取 JSONL output 和 SLS failed logs 作为健康信号 |
| core | dashboard 读取 service log 判断 collector 状态 |
| checkpoints | dashboard 可间接参考 input state 推断采集活跃度 |

## 扩展指南 (Extension Guide)

### 添加 dashboard 指标

1. 如果指标来自进程资源，优先扩展 `scripts/monitor-loongsuite-pilot.sh` 的 CSV schema。
2. 如果指标来自采集/上报结果，优先扩展 `scripts/lib/agent-overview.mjs`。
3. 在 `scripts/serve-loongsuite-pilot-monitor.mjs` 中暴露只读 API。
4. 更新 `assets/monitor/loongsuite-pilot-monitor.html` 和 `assets/monitor/README.md`。
5. 为聚合逻辑添加 unit test，避免 dashboard 读取大文件或阻塞采集路径。

## macOS 状态栏 App

Pilot 提供一个原生 macOS 状态栏 App 作为轻量可视化通道，与 dashboard server 并行共存。

### 架构

```
Orchestrator (collector daemon)
├── RuntimeWriter        → ~/.loongsuite-pilot/logs/runtime.json (30s 刷新)
├── MetricsSummaryWriter → ~/.loongsuite-pilot/logs/metrics-summary.json (60s 聚合)
└── StatusBarAppManager  → 管理 Swift binary 进程 (macOS only)

LoongSuitePilotMenuBarApp (Swift, 独立进程)
├── PilotRuntimeStore    ← 读 runtime.json (30s 轮询)
└── PilotMetricsStore    ← 读 metrics-summary.json (60s 轮询)
```

### 数据流

- **runtime.json**: `{ status, packageVersion, pid, updatedAt }` — daemon 存活证据
- **metrics-summary.json**: 预聚合的 token/session/request/tool 统计、provider 分布、repo 分布、趋势数据

### 进程管理

- `StatusBarAppManager` 在 Orchestrator 启动时自动启动 Swift binary
- 优先使用预编译 binary (`app/macos-status-bar/bin/darwin-{arch}/`)，fallback 到 `swift build`
- daemon 停止时 SIGTERM → 3s → SIGKILL
- App 检测到 daemon 连续 5 分钟不可用时自动退出

### 配置

- `enableStatusBarApp`: config.json 字段（默认 `true`）
- 环境变量: `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP`
- 仅 macOS 生效，非 darwin 平台跳过所有相关逻辑

### 源码位置

- Swift: `app/macos-status-bar/Sources/LoongSuitePilotMenuBarApp/`
- Daemon 侧: `src/status-bar/` (runtime-writer.ts, metrics-summary-writer.ts, status-bar-app-manager.ts)

## 约束 (Constraints)

1. **Monitor 必须保持可选**：collector 启停不依赖 monitor；monitor 失败不影响采集。
2. **Dashboard API 只读**：不得通过 dashboard API 修改配置、状态或 hook。
3. **不得进入采集热路径**：metrics/overview 聚合只能读已有文件和缓存。
4. **文件读取必须有边界**：读取 JSONL、CSV、service log 时必须限制窗口、行数或缓存。
5. **默认只监听本机地址**：dashboard host 默认为 `127.0.0.1`，避免无意暴露本地数据。
6. **PID 文件是生命周期边界**：start/stop/status 应通过 PID 文件和进程探测保持幂等。
7. **保留策略必须本地有界**：process metrics 文件按 retention 清理，避免长期增长。
8. **状态栏 App 必须保持可选**：编译/运行失败不影响 daemon 采集；非 macOS 跳过。
