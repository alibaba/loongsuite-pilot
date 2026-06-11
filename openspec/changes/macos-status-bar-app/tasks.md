## 1. Daemon 侧 — runtime.json 写入

- [x] 1.1 新建 `src/status-bar/runtime-writer.ts`：在 Orchestrator 启动后写入 `~/.loongsuite-pilot/logs/runtime.json`（status/packageVersion/pid/updatedAt），30s 定时刷新 updatedAt，stop 时删除文件。写入使用 write-tmp + rename 原子策略
- [x] 1.2 在 `src/core/orchestrator.ts` 中集成 RuntimeWriter：start() 步骤末尾调用 `runtimeWriter.start()`，stop() 调用 `runtimeWriter.stop()`
- [x] 1.3 为 RuntimeWriter 添加 unit test：验证写入格式、定时刷新、stop 后文件删除、原子写入

## 2. Daemon 侧 — metrics-summary.json 聚合写入

- [x] 2.1 新建 `src/status-bar/metrics-summary-writer.ts`：定期（60s）扫描 `~/.loongsuite-pilot/logs/output/*.jsonl`，聚合 token/session/request/tool/event 统计，按 today/7days/30days 窗口写入 `~/.loongsuite-pilot/logs/metrics-summary.json`
- [x] 2.2 实现 JSONL 聚合逻辑：遍历 event.name 为 `llm.response` 的记录提取 `gen_ai.usage.*` token 字段；遍历 `llm.request` 计数 request；遍历 `tool.call` 计数 tool；去重 `gen_ai.session.id` 计数 session
- [x] 2.3 实现 modelShares 聚合：按 `gen_ai.request.model` 分组统计 totalTokens/inputTokens/cacheReadTokens，计算 share 百分比
- [x] 2.4 实现 agentShares 聚合：按 `gen_ai.agent.type` 分组统计 sessions/events/tokens，计算 share 百分比
- [x] 2.5 实现 dailyTokens/dailySessions 趋势数据：按文件名日期（`*-YYYY-MM-DD.jsonl`）提取天粒度，覆盖近 30 天
- [x] 2.6 ~~实现 yearlyTokens 数据~~ — 设计决策：去掉 Token Heatmap，改为 Provider 分布和 Repo 分布
- [x] 2.7 将 modelShares 和 agentShares 按时间窗口（today/sevenDays/thirtyDays）分别聚合，嵌套进 `ranges` 内
- [x] 2.8 实现增量扫描优化：记录每个 JSONL 文件的上次扫描 offset，只读增量部分（今日文件全量扫描，历史文件增量）。summary 写入时合并增量和缓存
- [x] 2.9 在 `src/core/orchestrator.ts` 中集成 MetricsSummaryWriter：start() 步骤末尾调用 `metricsSummaryWriter.start()`，stop() 调用 `metricsSummaryWriter.stop()`
- [x] 2.10 实现原子写入：write-tmp + rename，避免 Swift 侧读到半写状态
- [x] 2.11 为 MetricsSummaryWriter 添加 unit test：验证各聚合维度准确性、时间窗口过滤、增量扫描正确性、原子写入、空文件/空目录容错
- [x] 2.12 新增 providerShares 聚合：按 `gen_ai.provider.name` 分组统计 token 占比
- [x] 2.13 新增 repoShares 聚合：按 `git.repo` 分组统计 sessions/events

## 3. Daemon 侧 — StatusBarAppManager 进程管理

- [x] 3.1 新建 `src/status-bar/status-bar-app-manager.ts`：参考 AI Trace 的 StatusBarAppManager 实现，管理 Swift binary 的安装、启动、停止、版本升级
- [x] 3.2 实现 `ensureInstalled()`：优先查找预编译 binary（`app/macos-status-bar/bin/darwin-universal/` 或 `darwin-arm64/`），fallback 到 `swift build -c release`
- [x] 3.3 实现 `start()`：spawn binary（detached, unref），写 `~/.loongsuite-pilot/logs/status-bar-app-runtime.json`（pid/executablePath/packageVersion/updatedAt）
- [x] 3.4 实现 `stop()`：SIGTERM → wait 3s → SIGKILL，删除 runtime record，包括清理孤儿进程（通过 pgrep 查找）
- [x] 3.5 实现 `syncDesiredState(config)`：根据 `enableStatusBarApp` 配置决定 start 或 stop
- [x] 3.6 在 `src/core/config-loader.ts` 扩展 config schema：新增 `enableStatusBarApp?: string` 字段，默认值 `"true"`
- [x] 3.7 在 `src/core/orchestrator.ts` 集成 StatusBarAppManager：非 darwin 平台跳过；start() 末尾调用 `syncDesiredState()`，stop() 调用 `stop()`
- [x] 3.8 为 StatusBarAppManager 添加 unit test：验证 ensureInstalled 的 binary 查找优先级、spawn 参数、stop 的信号序列、runtime record 的写入/删除

## 4. Swift 侧 — Package 骨架与入口

- [x] 4.1 创建 `app/macos-status-bar/Package.swift`：swift-tools-version 5.7，macOS 13+，executable target `LoongSuitePilotMenuBarApp`，无外部依赖
- [x] 4.2 创建 `app/macos-status-bar/Sources/LoongSuitePilotMenuBarApp/LoongSuitePilotMenuBarApp.swift`：`@main` 入口，创建 NSApplication + AppDelegate
- [x] 4.3 创建 `AppDelegate.swift`：`applicationDidFinishLaunching` 中设置 `.accessory` 激活策略，初始化 StatusBarController
- [x] 4.4 创建 `BuildInfo.swift`：编译时注入版本号（从 VERSION 文件读取或 build flag）
- [x] 4.5 创建 `StatusBarLogger.swift`：文件日志输出到 `~/.loongsuite-pilot/logs/status-bar-app-*.log`

## 5. Swift 侧 — 窗口与状态栏控制

- [x] 5.1 创建 `FloatingPanel.swift`：NSPanel + NSVisualEffectView，圆角 18px，透明背景，level: .floating，隐藏原生按钮，minSize 420×520
- [x] 5.2 创建 `StatusBarController.swift`：NSStatusItem + variableLength，图标用 `chart.bar.xaxis`，title 绑定今日 token，左键 toggle panel，右键 context menu（打开面板 / 退出）
- [x] 5.3 实现 panel position 逻辑：相对于状态栏按钮定位，屏幕边缘 clamp
- [x] 5.4 实现 global event monitor：面板外点击自动关闭

## 6. Swift 侧 — 数据层

- [x] 6.1 创建 `PilotRuntimeStore.swift`：30s Timer 轮询 `~/.loongsuite-pilot/logs/runtime.json`，解析为 `RuntimeSnapshot`（status/version/pid/updatedAt），通过 `kill(pid, 0)` 探测进程存活，@Published 发布 isReachable/snapshot
- [x] 6.2 创建 `PilotMetricsStore.swift`：60s Timer 轮询 `~/.loongsuite-pilot/logs/metrics-summary.json`，解析为 `MetricsSnapshot`，后台队列读文件 + 主线程更新 @Published snapshot
- [x] 6.3 定义 `PilotMetricsSnapshot` 结构体：包含 ranges 数据、agentStats、providerShares、repoShares、dailyTokens、dailySessions
- [x] 6.4 实现 `selectRange()` 方法：切换 aggregation range 时从已加载的 summary 中提取对应 range 数据，无需重读文件
- [x] 6.5 实现 `menuBarTitle` 计算属性：返回格式化的今日 token 总量（如 "12.3M"）
- [x] 6.6 实现 `Formatters` 工具枚举：compactNumber（K/M/B 缩写）、percent（百分比格式化）

## 7. Swift 侧 — 面板 UI（极简仪表盘设计）

- [x] 7.1 创建 `PanelContentView.swift`：极简暗色设计（indigo 强调色），无装饰背景
- [x] 7.2 实现 header：status dot + "LoongSuite Pilot" + version badge + sync time + close button
- [x] 7.3 实现 statsGrid：4 列统计卡片（tokens/sessions/requests/tools）
- [x] 7.4 实现 rangeSelector：今日/7天/30天切换
- [x] 7.5 实现 agentsSection：Agent 健康看板列表（status dot + name + events + tokens）
- [x] 7.6 实现 providersSection：Provider 分布进度条（name + share% + tokens）
- [x] 7.7 实现 reposSection：Repository 列表（folder icon + repo + sessions + events）
- [x] 7.8 实现 tokenTrendSection：Charts AreaMark + LineMark 折线图
- [x] 7.9 实现 sessionTrendSection：Charts BarMark 柱状图
- [x] 7.10 实现 tokenBreakdownSection：三列（INPUT / OUTPUT / CACHE HIT）
- [x] 7.11 实现 errorSection：amber 色警告 banner

## 8. Swift 侧 — Daemon 健康自检

- [x] 8.1 在 PilotRuntimeStore 中实现 daemon 离线检测：若连续 3 次（3 × 30s = 90s）检测到 pid 已死，设置 statusText 为 "守护进程未运行"
- [x] 8.2 实现 App 自退出逻辑：若 daemon 长时间不可用（10 × 30s = 5 分钟），App 自动退出

## 9. 构建与分发

- [x] 9.1 创建 `scripts/build-status-bar-app.mjs`：调用 swiftc 编译，产出 binary 到 `app/macos-status-bar/bin/darwin-{arch}/`
- [x] 9.2 在 `build.mjs` 中集成状态栏 App 构建：macOS 环境下在主构建完成后 best-effort 触发 swift 编译
- [x] 9.3 在 `deploy/package.sh` 中将 `app/macos-status-bar/` 纳入 tarball（含预编译 binary 和 Swift 源码）
- [x] 9.4 验证 swift build 兼容性：需要完整 Xcode 或匹配版本的 Command Line Tools

## 10. 集成验证

- [x] 10.1 手动端到端验证：启动 pilot daemon → 确认 runtime.json 写入 → 确认 metrics-summary.json 生成 → 确认状态栏 App 自动启动 → 面板展示真实数据（48.5M tokens / 2 sessions / anthropic / sls/loongsuite-pilot）
- [x] 10.2 验证面板数据与 dashboard 统计逻辑一致性：token 计算语义对齐（total_tokens = input + output，cache 是子集不重复计算）
- [x] 10.3 验证进程管理生命周期：daemon stop → StatusBarAppManager.stop() → Swift App 自动退出
- [x] 10.4 验证 fallback 行为：swift build 不可用时 daemon 正常运行；metrics-summary.json 不存在时面板显示空状态

## 11. Baseline 文档更新

- [x] 11.1 更新 `docs/modules/monitor.md`：补充状态栏 App 架构、数据流、进程管理、配置说明
- [x] 11.2 更新 `docs/modules/runtime.md`：补充 runtime.json 规范、StatusBarAppManager、构建脚本
- [x] 11.3 更新 `docs/modules/core.md`：补充 Orchestrator 启动序列 step 12（status bar 支持）和 statusBar config 字段
- [x] 11.4 验证实现符合 baseline constraints（monitor 可选、只读、不进入热路径）
