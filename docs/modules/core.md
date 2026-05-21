# Module: core

> Last verified: 2026-05-13

## 职责 (Responsibility)

系统中枢编排层，负责加载配置、组装子系统、管理 agent 生命周期及日志保留策略。

## 公共接口 (Public Interface)

- **Orchestrator** — 系统核心协调器，管理整个服务生命周期（启动、停止），提供对 InputManager、AgentControlManager、AgentDiscoveryService 等子系统的访问入口。继承 EventEmitter，发射 starting/started/stopped 事件。
- **ConfigLoader** — 负责加载和合并三层配置（环境变量 > 配置文件 > 默认值），返回统一的 AnalyticsConfig 对象；同时提供 AutoUpdateConfig 构建能力。
- **InputManager** — Input 源生命周期管理器与数据路由器。核心职责**仅限于**：(1) Input source 的注册、启动、停止等生命周期管理；(2) 监听各 Input 的 `entries` 事件；(3) 将 entries 路由至 flusher(s)。InputManager 不应承载任何数据富化或数据变换逻辑。继承 EventEmitter，发射 dispatched 事件。
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
- 数据过滤/脱敏（如 content policy）→ 应通过 middleware 或 hook 层实现

## 内部设计 (Internal Design)

### 启动序列 (Startup Sequence)

Orchestrator 启动分为以下阶段：

1. **存储与控制层初始化** — 初始化 StateStore（偏移量追踪）、SnapshotStore（去重缓存）、AgentControlManager（准入控制）
2. **输出管道构建** — 根据配置构建 flusher 实例（SLS、JSONL、HTTP），组装为 MultiFlusher
3. **输入源注册** — 通过 InputManager 注册所有 Agent Input source
4. **发现与生命周期管理** — 启动 AgentDiscoveryService（fs.watch + 轮询），检测 Agent 存在并管理 Input 的 start/stop 生命周期
5. **清理服务** — 启动 LogRetentionService 进行日志轮转

### ConfigLoader 优先级模型
三层配置加载，高优先级覆盖低优先级：
- Environment variables（最高）
- Config file (`~/.loongsuite-pilot/config.json`)
- Built-in defaults（最低）

### SLS 目的地解析
ConfigLoader 根据用户提供的 SLS 字段和编译期常量 `__INTERNAL_BUILD__` 解析出最终的 SLS endpoint 列表。集团内版本（`__INTERNAL_BUILD__ = true`）始终包含内置目的地，用户配了自有 SLS 时自动双发；集团外版本（`__INTERNAL_BUILD__ = false`）仅使用用户目的地。

### AgentDiscoveryService 状态机
每个 entry 拥有独立状态：`Idle → Starting → Running → Stopping → Idle`

发现策略：优先 `fs.watch` 监控 watchPaths；watch 失败自动降级到定时 polling。

### AgentControlManager 三级门控
- `"on"` → 强制启用
- `"off"` → 强制禁用
- `"auto"`（默认）→ 委派给配置默认值 / isAvailable 检测

### InputManager 数据流

`Input.emit('entries')` → `InputManager` routes → `flusher.sendBatch()`

InputManager 仅负责将 Input 产出的 entries 路由至已注册的 flusher(s)。所有 cross-cutting 数据处理（userId 富化、content policy、字段标准化）在 hook 层完成，发生在 entries 进入 InputManager 之前。

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
| normalization | `applyAgentContentPolicy` |
| utils | `createLogger`, `resolveHome`, `ensureDir`, `readJsonFile`, `writeJsonFile` |

## 约束 (Constraints)

1. **单实例运行**：Orchestrator 内部使用 `isRunning` 标志防止重复启动。
2. **Hook 安装为 best-effort**：hook 安装失败不应中断启动流程。
3. **配置不可热更新**：config 在 `start()` 时加载一次，运行中不重新读取。
4. **InputManager 必须先设置 flusher**：否则 entries 将被丢弃并记录 warning。
5. **Flusher 始终存在**：无任何 flusher 启用时自动回退到 JSONL。
6. **AgentDiscoveryService 不直接操作 Input**：通过 `AgentDetectionEntry.start/stop` 回调间接委派给 InputManager。
7. **LogRetentionService 仅删除包含日期后缀的文件**：不匹配 `YYYY-MM-DD` 格式的文件永不被清理。
8. **InputManager 不应承载数据变换逻辑**：如需新增 cross-cutting 数据处理（富化、过滤、脱敏等），应以 middleware 形式实现，而非修改 InputManager。
