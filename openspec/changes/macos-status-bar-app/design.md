## Context

LoongSuite Pilot 是一个多智能体 AI 编码数据采集守护进程，当前唯一的可视化通道是手动启动的 `monitor start` dashboard（Node.js HTTP server + HTML 页面）。内部已有另一个产品 AI Trace（`@ali/ai-coding-trace`）实现了一套成熟的 macOS 原生状态栏 App，基于 Swift + SwiftUI + AppKit，直接从本地 SQLite 读取数据展示多维度面板。

本设计将参考 AI Trace 的架构，为 Pilot 实现同等体验的原生状态栏 App，但在数据层做适配：Pilot 的数据源是 JSONL 文件（非 SQLite），因此采用"daemon 侧聚合 + JSON 文件传递 + Swift 侧轻量读取"的方案。

### Current State

- Pilot collector daemon 以 Node.js 后台进程运行（`~/.loongsuite-pilot/bin/collector-daemon.js`）
- 输出目录 `~/.loongsuite-pilot/logs/output/` 按日期和 agent 分 JSONL 文件（如 `claude-code-2026-06-08.jsonl`）
- JSONL 中每条 event 包含 `gen_ai.usage.*` token 字段、`gen_ai.session.id`、`gen_ai.agent.type`、`gen_ai.request.model` 等
- 已有 monitor dashboard 通过 `agent-overview.mjs` 聚合 JSONL 生成 overview JSON
- 无 runtime.json、无 metrics summary、无状态栏 App

### Constraints

- TypeScript ESM-only codebase（daemon 侧）
- Swift Package Manager (swift-tools-version 5.7+)（Swift 侧）
- macOS 13+ target
- 状态栏 App 可选——编译/运行失败不影响 daemon 正常采集
- 不引入新的持久化层（不加 SQLite），继续基于文件系统

## Goals / Non-Goals

**Goals:**
- 原生 macOS 状态栏图标，显示今日 token 总量
- 点击展开浮动面板，展示多维度仪表盘（对标 AI Trace 的全部视觉板块）
- Daemon 定期生成 `metrics-summary.json`，Swift 侧只读 JSON
- Daemon 写入 `runtime.json`，Swift 侧判断服务状态
- Daemon 管理 Swift binary 进程的启停和版本升级
- 支持预编译 universal binary 和本地 swift build 两种模式
- 可通过 config.json `enableStatusBarApp` 开关控制

**Non-Goals:**
- 非 macOS 平台支持（Linux/Windows 不涉及）
- 替代现有 monitor dashboard（两者共存）
- 实时流数据推送（定时轮询足够）
- Swift 侧直接解析 JSONL 文件
- 状态栏 App 修改配置或控制 daemon（只读展示）

## Decisions

### 1. Swift 侧读 JSON 文件 vs 直读 JSONL vs HTTP API

**Decision**: Daemon 侧定期聚合 JSONL 写入 `metrics-summary.json`，Swift 侧只读此 JSON。

**Rationale**: 
- JSONL 文件可能很大（单日上千行），Swift 逐行解析性能差且需要重复实现 Node 侧已有的聚合逻辑
- HTTP API 需要 daemon 侧新增 HTTP server（pilot 当前 collector 无 HTTP 入口），引入额外复杂度
- JSON 文件方案最简单：daemon 已有聚合能力（参考 `agent-overview.mjs`），Swift 只需 `JSONDecoder`

**Trade-off**: 数据有最多一个聚合周期的延迟（60s），但状态栏场景完全可接受。

### 2. metrics-summary.json 聚合周期

**Decision**: 60 秒。

**Rationale**: 与 AI Trace 的 `SessionMetricsStore` 刷新间隔一致。对于状态栏展示场景，分钟级别的数据新鲜度已足够。更短的周期会增加不必要的文件 I/O。

### 3. metrics-summary.json 数据结构

**Decision**: 单文件包含所有时间窗口的预聚合数据。

```json
{
  "version": 1,
  "generatedAt": "2026-06-08T12:00:00.000Z",
  "packageVersion": "1.1.3",
  "ranges": {
    "today": {
      "totalTokens": 12345678,
      "inputTokens": 12000000,
      "outputTokens": 345678,
      "cacheReadTokens": 10500000,
      "totalSessions": 5,
      "totalRequests": 78,
      "totalToolCalls": 150,
      "totalEvents": 556
    },
    "sevenDays": { "..." : "same shape" },
    "thirtyDays": { "..." : "same shape" }
  },
  "modelShares": [
    {
      "model": "claude-opus-4-6",
      "totalTokens": 8000000,
      "inputTokens": 7800000,
      "cacheReadTokens": 6500000,
      "share": 0.65
    }
  ],
  "agentShares": [
    {
      "agentType": "claude-code",
      "sessions": 3,
      "events": 187,
      "tokens": 8000000,
      "share": 0.60
    }
  ],
  "dailyTokens": [
    { "day": "2026-06-01", "value": 500000 },
    { "day": "2026-06-02", "value": 1200000 }
  ],
  "dailySessions": [
    { "day": "2026-06-01", "value": 2 },
    { "day": "2026-06-02", "value": 5 }
  ],
  "yearlyTokens": [
    { "day": "2025-12-09", "value": 0 },
    { "day": "2025-12-10", "value": 300000 }
  ]
}
```

**Rationale**: 
- 预聚合所有时间窗口，Swift 侧切换 tab 时无需重新触发聚合
- `modelShares` 和 `agentShares` 取当前 `selectedRange` 对应的数据（daemon 侧按最大窗口聚合，Swift 侧根据 range 过滤）
- `dailyTokens`/`dailySessions` 覆盖 30 天即可支持 7 天和 30 天趋势图
- `yearlyTokens` 覆盖近 6 个月，支持 Token Heatmap

**Trade-off**: 单文件预聚合所有窗口导致文件稍大（~50KB），但远小于直读 JSONL，且只写一次。实际实现中 `modelShares` 和 `agentShares` 按时间窗口分别聚合（嵌套在 `ranges` 内），Swift 侧直接按 range 取值。

### 4. runtime.json 结构与写入时机

**Decision**: Orchestrator 启动时写入，定期刷新 `updatedAt`。

```json
{
  "status": "active",
  "packageVersion": "1.1.3",
  "pid": 14491,
  "updatedAt": "2026-06-08T12:00:00.000Z"
}
```

**Rationale**: 与 AI Trace 的 `~/.r2c/logs/code-collect/runtime.json` 结构对齐，但简化掉 host/port（Pilot collector 暂无 HTTP 入口）。Swift 侧通过读 `status` + 检测 `pid` 进程存活判断 daemon 健康。

**Write strategy**: 
- Orchestrator.start() 时首次写入
- 每 30s 刷新 `updatedAt`（证明进程活着）
- Orchestrator.stop() 时删除文件
- 先写 `.tmp` 再 `rename`，保证原子性

### 5. StatusBarAppManager 进程管理策略

**Decision**: 参考 AI Trace 的 `StatusBarAppManager`，实现相同的生命周期管理。

**Architecture**:
```
Orchestrator.start()
    └── StatusBarAppManager.syncDesiredState()
            ├── config.enableStatusBarApp === true?
            │       ├── ensureInstalled()
            │       │       ├── 优先用预编译 binary (bin/darwin-universal/ 或 bin/darwin-arm64/)
            │       │       └── fallback: swift build -c release
            │       └── spawn(binary, { detached: true })
            │               └── write status-bar-app-runtime.json (pid, executablePath, version)
            └── config.enableStatusBarApp === false?
                    └── stop() → SIGTERM → wait → SIGKILL
```

**Key behaviors**:
- 预编译 binary 优先，swift build 仅作为 fallback
- spawn 后 `child.unref()` 确保 daemon 退出时状态栏 App 不受影响
- 版本升级时先 stop 旧进程再 start 新进程
- swift build 失败只 log warning，不中断 daemon
- 运行时记录写入 `~/.loongsuite-pilot/logs/status-bar-app-runtime.json`

### 6. Swift 面板 UI 对标策略

**Decision**: 视觉设计、组件结构、色彩方案完全参考 AI Trace 的 `PanelContentView.swift`，品牌和数据维度做适配。

| 组件 | AI Trace 实现 | Pilot 适配 |
|------|-------------|-----------|
| Design Tokens | 暗色赛博风 (DT.bgDeep / DT.cyan / DT.blue...) | 完全复用 |
| FloatingPanel | NSPanel + NSVisualEffectView, 560×760 | 同 |
| StatusBarController | NSStatusItem + waveform icon + token title | icon 改用 `chart.bar.xaxis`，title 同 |
| Header | "AI Trace" + version + status dot | "LoongSuite Pilot" + version + status dot |
| Hero | totalTokens + events + sessions/requests/tools | 同 |
| Token Breakdown | input/output/cache read share | 同 |
| Token Heatmap | 6 个月日粒度热力图 | 同 |
| Model Share | 水平进度条 + cache read overlay | 同 |
| Skill Calls | 表格: skill name / version / count | 替换为 Agent Collection: agent type / events / tokens |
| Token/Session Trend | Charts AreaMark / BarMark | 同 |
| Client Type | 环形图 + legend | 同 |

### 7. Swift 数据刷新策略

**Decision**: 
- `PilotRuntimeStore`: 30s 轮询 `runtime.json`，判断 daemon 状态
- `PilotMetricsStore`: 60s 轮询 `metrics-summary.json`，刷新面板数据
- 面板打开时立即触发一次刷新
- 切换 range 时从已加载的 summary 中提取对应 range 数据（无需重新读文件）

**Rationale**: 与 AI Trace 完全对齐的刷新策略（RuntimeStateStore 30s，SessionMetricsStore 60s）。

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Swift build 在无 Xcode 环境失败 | 状态栏 App 不可用 | 优先使用预编译 binary；build 失败只 log 不中断 |
| metrics-summary.json 写入和读取竞争 | Swift 读到部分写入的文件 | 原子写入（write tmp + rename） |
| JSONL 文件很大时聚合耗时 | daemon 主循环被阻塞 | 在 worker thread / setImmediate 中异步聚合；增量扫描（checkpoint offset） |
| 跨天文件积累（6 个月 Heatmap） | 需扫描大量历史文件 | yearlyTokens 独立聚合，TTL 缓存，只在面板打开时全量计算 |
| 老版本 Pilot 无 StatusBarAppManager | 状态栏 App 进程成为孤儿 | Swift App 自行检测 daemon 健康，daemon 不在则自动退出 |
| config.json 无 enableStatusBarApp 字段 | 新旧 config 兼容 | 默认值 `true`（与 AI Trace 的 `resolveStatusBarAppEnabled` 策略一致，但默认开启） |
