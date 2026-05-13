# Module: core

> Last verified: 2026-05-13

## 职责 (Responsibility)

系统中枢编排层，负责加载配置、组装子系统、管理 agent 生命周期及日志保留策略。

## 公共接口 (Public Interface)

### Orchestrator (`orchestrator.ts`)
```ts
class Orchestrator extends EventEmitter {
  constructor(config: AnalyticsConfig)
  start(): Promise<void>
  stop(): Promise<void>
  getInputManager(): InputManager
  getAgentControlManager(): AgentControlManager
  getAgentDiscoveryService(): AgentDiscoveryService
  setUserId(userId: string): void
}
// Events: 'starting' | 'started' | 'stopped'
```

### loadConfig (`config-loader.ts`)
```ts
function loadConfig(): Promise<AnalyticsConfig>
function buildAutoUpdateConfig(file): AutoUpdateConfig
```

### InputManager (`input-manager.ts`)
```ts
class InputManager extends EventEmitter {
  setFlusher(flusher: BaseFlusher): void
  setUserId(userId: string): void
  setConfiguredUserId(userId: string): void
  setAgentsConfig(config: AgentsConfig): void
  registerInput(input: BaseInput): void
  startInput(id: string): Promise<void>
  stopInput(id: string): Promise<void>
  stopAll(): Promise<void>
  buildDetectionEntry(input, opts): AgentDetectionEntry
}
// Events: 'dispatched'
```

### AgentDiscoveryService (`agent-discovery-service.ts`)
```ts
class AgentDiscoveryService extends EventEmitter {
  constructor(entries: AgentDetectionEntry[])
  start(): Promise<void>
  stop(): Promise<void>
  refresh(trigger?: string): Promise<void>
  getStates(): Record<string, EntryState>
}
// Events: 'agent:started' | 'agent:stopped'
```

### AgentControlManager (`agent-control-manager.ts`)
```ts
class AgentControlManager {
  constructor(filePath?: string)
  load(): Promise<void>
  save(): Promise<void>
  resolveEnabled(agentId: string, defaultWhenAuto?: boolean): boolean
  getMode(agentId: string): AgentControlMode
  setMode(agentId: string, mode: AgentControlMode): void
  getAllModes(): Record<string, AgentControlMode>
}
```

### LogRetentionService (`log-retention-service.ts`)
```ts
class LogRetentionService {
  constructor(dataDir: string, config: LogRetentionConfig)
  start(): void
  stop(): void
  runCleanup(): Promise<{ deleted: number; errors: number }>
}
function extractDate(filename: string): string | null
```

## 内部设计 (Internal Design)

### Orchestrator 启动序列
1. 确保 dataDir 和 logs 目录存在
2. 加载 StateStore（输入游标持久化）和 AgentControlManager（准入控制）
3. 构建 Flusher 管线（SLS → JSONL → HTTP，多目标使用 MultiFlusher）
4. 创建 InputManager，注入 flusher 和配置
5. 安装 Hook 脚本（Cursor, Qoder CLI, QoderWork）
6. 注册所有 Input 并生成 AgentDetectionEntry 列表
7. 启动 AgentDiscoveryService（fs.watch + 定时轮询）
8. 启动 LogRetentionService

### ConfigLoader 优先级模型
三层配置加载，高优先级覆盖低优先级：
- Environment variables（最高）
- Config file (`~/.loongsuite-pilot/config.json`)
- Built-in defaults（最低）

### AgentDiscoveryService 状态机
每个 entry 拥有独立状态：`Idle → Starting → Running → Stopping → Idle`

发现策略：优先 `fs.watch` 监控 watchPaths；watch 失败自动降级到定时 polling。

### AgentControlManager 三级门控
- `"on"` → 强制启用
- `"off"` → 强制禁用
- `"auto"`（默认）→ 委派给配置默认值 / isAvailable 检测

### InputManager 数据流
`Input.emit('entries')` → enrich `user.id` → `applyAgentContentPolicy()` → `flusher.sendBatch()`

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
