# Module: core

> Last verified: 2026-06-04

## 职责 (Responsibility)

系统中枢编排层，负责加载配置、组装子系统、管理 agent 生命周期及日志保留策略。

## 公共接口 (Public Interface)

- **Orchestrator** — 系统核心协调器，管理整个服务生命周期（启动、停止），提供对 InputManager、AgentControlManager、AgentDiscoveryService 等子系统的访问入口。继承 EventEmitter，发射 starting/started/stopped 事件。
- **ConfigLoader** — 负责加载和合并三层配置（环境变量 > 配置文件 > 默认值），返回统一的 AnalyticsConfig 对象；同时提供 AutoUpdateConfig 构建能力。
- **InputManager** — Input 源生命周期管理器与数据路由器。核心职责**仅限于**：(1) Input source 的注册、启动、停止等生命周期管理；(2) 监听各 Input 的 `entries` 事件；(3) 调用 collector 级统一处理器（userId、content policy、mask）；(4) 将处理后的 entries 路由至 flusher(s)。InputManager 不承载具体规则和扫描细节。继承 EventEmitter，发射 dispatched 事件。
- **AgentDiscoveryService** — Agent 存在性发现服务，通过 fs.watch + 定时轮询监测 agent 数据目录，自动触发 Input 的 start/stop。继承 EventEmitter，发射 agent:started/agent:stopped 事件。
- **AgentControlManager** — Agent 准入控制器，管理每个 agent 的启用模式（on/off/auto），支持持久化到文件并按需加载。
- **LogRetentionService** — 日志保留服务，按配置的保留天数和文件日期后缀定期清理过期日志文件。

## 不负责 (NOT Responsible For)

- 数据采集逻辑 → inputs 模块负责
- 数据序列化与脱敏 → normalization 模块负责
- 数据输出/发送 → flushers 模块负责
- Hook 脚本安装与管理 → hooks 模块负责
- 自动更新逻辑 → updater 模块负责
- 数据富化（如 userId 注入）→ 应通过 middleware 或 hook 层实现
- 数据过滤/脱敏规则细节（如 content policy 字段集合、mask 规则扫描）→ 应通过 normalization / mask 模块实现

## 内部设计 (Internal Design)

### 启动序列 (Startup Sequence)

Orchestrator 启动分为以下阶段：

1. **存储与控制层初始化** — 初始化 StateStore（偏移量追踪）、SnapshotStore（去重缓存）、AgentControlManager（准入控制）
2. **输出管道构建** — 根据配置构建 flusher 实例（SLS、JSONL、HTTP），组装为 MultiFlusher
3. **输入源注册** — 通过 InputManager 注册所有 Agent Input source
4. **发现与生命周期管理** — 启动 AgentDiscoveryService（fs.watch + 轮询），检测 Agent 存在并管理 Input 的 start/stop 生命周期
5. **清理服务** — 启动 LogRetentionService 进行日志轮转
6. **文件采集管道** — 当 `config.fileCollection.enabled` 为 `true` 时启动 FileCollectionManager，监控 `~/.loongsuite-pilot/configs/local/` 目录，动态加载/卸载文件采集 pipeline（与 agent activity 管道独立运行）。默认关闭。
7. **状态栏支持** — 启动 RuntimeWriter（写 runtime.json）、MetricsSummaryWriter（聚合 metrics-summary.json）、StatusBarAppManager（管理 Swift binary 进程，仅 macOS）。由 `config.statusBar.enabled` 控制。

### ConfigLoader 优先级模型
三层配置加载，高优先级覆盖低优先级：
- Environment variables（最高）
- Config file (`~/.loongsuite-pilot/config.json`)
- Built-in defaults（最低）

### config.json 文件采集字段
- `fileCollection.enabled` (boolean) — 控制文件采集开关，默认 `false`。环境变量: `LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED`

`buildFileCollectionConfig()` 构建 `FileCollectionToggle { enabled }`。

### config.json 状态栏字段
- `enableStatusBarApp` (boolean|string) — 控制状态栏 App 开关，默认 `true`。环境变量: `LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP`

`buildStatusBarConfig()` 构建 `StatusBarConfig { enabled, metricsSummaryIntervalMs(60s), runtimeRefreshIntervalMs(30s) }`。

### config.json 灰度发布字段
`config.json` 中与灰度发布相关的字段：
- `installId` (string) — 机器唯一标识，updater 首次运行时自动生成 UUID v4，用于灰度分桶
- `canary.policy` (`'auto'` | `'latest'` | `'off'`) — 灰度策略：`auto`（默认）走服务端百分比控制；`latest` 强制使用最新 canary 版本；`off` 强制退出灰度
- `canary.hotfix_version` (number) — updater 维护，记录当前 canary hotfix 版本号，用于 hotfix 比较

`buildAutoUpdateConfig()` 从上述字段构建 `AutoUpdateConfig`，其中 `canaryHotfixVersion` 默认值为 `config.canary?.hotfix_version ?? 0`。

### SLS 目的地解析
ConfigLoader 从两个来源合并 SLS endpoint 列表：
- `~/.loongsuite-pilot/config.json` — 用户自定义 SLS endpoints
- `~/.loongsuite-pilot/configs/inner/data_config.json` — 集团版内置 SLS endpoints（仅集团版存在）

合并时 config.json 的 endpoints 排在前面，通过 `endpoint|project|logstore` 组合键去重，用户配置优先。有完整的 endpoint/project/logstore 配置则启用，没有则禁用。安装脚本在部署时按需注入 SLS 配置。

### AgentDiscoveryService 状态机
每个 entry 拥有独立状态：`Idle → Starting → Running → Stopping → Idle`

发现策略：优先 `fs.watch` 监控 watchPaths；watch 失败自动降级到定时 polling。

### AgentControlManager 三级门控
- `"on"` → 强制启用
- `"off"` → 强制禁用
- `"auto"`（默认）→ 委派给配置默认值 / isAvailable 检测

### InputManager 数据流

`Input.emit('entries')` → `InputManager` enriches user.id → `applyAgentContentPolicy()` → `maskAgentActivityEntry()` → `flusher.sendBatch()`

InputManager 负责调用 collector 级统一处理器并将处理后的 entries 路由至已注册的 flusher(s)。具体 content policy 字段集合由 normalization 模块维护，具体 secret 规则和扫描逻辑由 mask 模块维护。这样 JSONL / SLS / HTTP log 与 OTLP trace 都收到同一份已处理 entry。

### LogRetentionService
延迟 30s 后执行首次清理，之后按 `intervalMs` 周期运行。按日期后缀和分类目录决定保留天数。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AnalyticsConfig`, `AgentDetectionEntry`, `EntryState`, `AgentControlConfig`, `LogRetentionConfig` |
| inputs | `BaseInput` (type only), 所有具体 Input 类 |
| flushers | `BaseFlusher`, `SlsFlusher`, `JsonlFlusher`, `HttpFlusher`, `MultiFlusher` |
| checkpoints | `StateStore` |
| hooks | `HookManager` |
| file-collection | `FileCollectionManager` |
| normalization | `applyAgentContentPolicy` |
| mask | `maskAgentActivityEntry`, `loadEnabledRules` |
| utils | `createLogger`, `resolveHome`, `ensureDir`, `readJsonFile`, `writeJsonFile` |

## 约束 (Constraints)

1. **单实例运行**：Orchestrator 内部使用 `isRunning` 标志防止重复启动。
2. **Hook 安装为 best-effort**：hook 安装失败不应中断启动流程。
3. **配置不可热更新**：config 在 `start()` 时加载一次，运行中不重新读取。
4. **InputManager 必须先设置 flusher**：否则 entries 将被丢弃并记录 warning。
5. **Flusher 始终存在**：无任何 flusher 启用时自动回退到 JSONL。
6. **AgentDiscoveryService 不直接操作 Input**：通过 `AgentDetectionEntry.start/stop` 回调间接委派给 InputManager。
7. **LogRetentionService 仅删除包含日期后缀的文件**：不匹配 `YYYY-MM-DD` 格式的文件永不被清理。
8. **InputManager 不应承载规则细节**：如需新增 cross-cutting 数据处理（富化、过滤、脱敏等），InputManager 只能调用独立模块；字段集合、规则、扫描算法不得散落在 InputManager 中。
