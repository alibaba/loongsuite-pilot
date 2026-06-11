## Why

当前 Pilot 的监控只有一个需要手动启动的 `monitor start` dashboard，开发者无法在日常工作流中随时掌握采集状态和 token 消耗情况。AI Trace 已有一个成熟的 macOS 状态栏 App（原生 Swift、SwiftUI），提供了 token 汇总、模型分布、热力图、趋势图等多维度可视化面板，开发者只需点击状态栏图标即可查看。Pilot 需要实现类似的原生状态栏 App，数据维度尽可能对标 AI Trace，让用户一键感知多 agent 采集全局状态。

## What Changes

### 1. 新增原生 Swift macOS 状态栏 App

在 `app/macos-status-bar/` 下新增 Swift Package 项目，参考 AI Trace 的架构（`StatusBarController` + `FloatingPanel` + `PanelContentView`），实现原生 macOS 状态栏 App：

- 状态栏图标显示今日 token 总量（如 "12.3M"）
- 点击展开浮动面板，展示多维度仪表盘
- 右键菜单支持：打开面板、浏览器打开、退出

### 2. Daemon 侧新增 metrics summary 写入

Pilot collector daemon 定期聚合 output JSONL 文件，生成 `~/.loongsuite-pilot/logs/metrics-summary.json`，供 Swift 侧轻量读取，避免 Swift 直接扫描大量 JSONL 文件。

聚合维度（对标 AI Trace）：
- 今日/7天/30天 token 汇总（input/output/cache_read/total）
- session 数、request 数、tool_call 数
- event 总数
- 按 model 分组的 token 占比
- 按 agent type 分组的 session 占比（替代 AI Trace 的 Skill Calls）
- 按天的 token 趋势数据（近 30 天）
- 按天的 session 趋势数据（近 30 天）
- 近 6 个月的每日 token 汇总（Token Heatmap 用）

### 3. Daemon 侧新增 runtime.json 写入

Pilot collector daemon 启动后写入 `~/.loongsuite-pilot/logs/runtime.json`，包含：

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "status": "active",
  "packageVersion": "1.1.3",
  "updatedAt": "2026-06-08T12:00:00.000Z",
  "pid": 14491
}
```

Swift 侧通过读此文件判断 daemon 是否运行、当前版本、上次更新时间等。

### 4. Daemon 侧新增状态栏 App 进程管理

参考 AI Trace 的 `StatusBarAppManager`，在 Pilot daemon 中新增 `StatusBarAppManager`：
- 启动时自动编译或使用预编译 Swift binary
- 管理状态栏 App 进程的启/停/重启
- 版本升级时 graceful restart
- 通过 runtime record 追踪运行状态
- config.json 新增 `enableStatusBarApp` 开关

### 5. 面板展示内容（对标 AI Trace）

| 板块 | AI Trace 原版 | Pilot 适配 |
|------|-------------|-----------|
| Header | 版本号 + 状态 + 同步时间 | 同，品牌改为 "LoongSuite Pilot" |
| Range Selector | 今日 / 7天 / 30天 | 同 |
| Hero Section | 总 token + changes + sessions/requests/tools | 同，changes 改为 events captured |
| Token Breakdown | 输入/输出/缓存命中 | 同 |
| Token Heatmap | 近 6 月每日热力图 | 同 |
| Model Share | 模型 token 占比 | 同 |
| ~~Skill Calls~~ | skill name / version / count | 替换为 Agent Collection：agent type / events / tokens |
| Token Trend | 折线图 | 同 |
| Session Trend | 柱状图 | 同 |
| Client Type | 饼图 + 图例 | 同，即 agent type 分布 |

## Capabilities

### New Capabilities
- `status-bar-app`: macOS 原生状态栏 App — Swift Package 构建、SwiftUI 面板 UI、FloatingPanel 窗口管理、多维度数据可视化
- `metrics-summary`: daemon 侧 JSONL 聚合 — 定期扫描 output JSONL 文件，写入 metrics-summary.json 供状态栏 App 消费
- `status-bar-process-management`: 状态栏 App 进程管理 — daemon 管理 Swift binary 编译/启停/升级

### Modified Capabilities
（无现有 spec 需要修改）

## Impact

### Affected Baseline Modules
- **monitor** (`docs/modules/monitor.md`): 新增一个并行的可视化通道（状态栏 App），与现有 dashboard server 共存但独立运行。metrics-summary.json 的聚合逻辑参考 `agent-overview.mjs` 但实现在 daemon 侧
- **core** (`docs/modules/core.md`): Orchestrator 扩展 — 启动时写入 runtime.json、启动 StatusBarAppManager、定期触发 metrics summary 写入
- **runtime** (`docs/modules/runtime.md`): 新增 Swift binary 编译/部署/管理能力；config.json schema 新增 `enableStatusBarApp` 字段
- **updater** (`docs/modules/updater.md`): 版本升级后触发状态栏 App 重启（如有新版本 Swift binary）

### Affected Code — Daemon 侧 (TypeScript)
- `src/core/orchestrator.ts` — 集成 metrics summary 写入和 runtime.json 写入
- `src/status-bar/status-bar-app-manager.ts` — 新增，进程管理
- `src/status-bar/metrics-summary-writer.ts` — 新增，JSONL 聚合写入
- `src/status-bar/runtime-writer.ts` — 新增，runtime.json 写入
- `src/core/config-loader.ts` — config schema 扩展

### Affected Code — Swift 侧（全新）
- `app/macos-status-bar/Package.swift`
- `app/macos-status-bar/Sources/LoongSuitePilotMenuBarApp/` — 全部 Swift 源码

### Baseline Modification
- `docs/modules/monitor.md` 需更新：补充状态栏 App 作为新的可视化通道
- `docs/modules/runtime.md` 需更新：补充 Swift binary 管理和 runtime.json 规范
- `docs/modules/core.md` 需更新：补充 metrics summary 和 runtime.json 的写入职责

### Design Constraints
- **状态栏 App 必须保持可选**：默认开启，但可通过 `enableStatusBarApp: false` 关闭
- **仅 macOS 生效**：非 darwin 平台跳过所有状态栏相关逻辑
- **不进入采集热路径**：metrics summary 写入是定时后台任务，不阻塞 Input → Flusher 管线
- **Swift binary 编译 fallback**：优先使用预编译 binary；编译失败不影响 daemon 正常运行
- **runtime.json 写入原子化**：先写临时文件再 rename，避免 Swift 侧读到半写状态
- **metrics-summary.json 读写边界**：只聚合 output 目录下的 JSONL，有文件大小和行数上限
