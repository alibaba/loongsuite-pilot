## Technical Design

### 策略：参数化而非独立 class

QoderWork CN 与 QoderWork 共享相同的 SDK log 格式和 SQLite schema，仅数据路径和 ClientType 不同。因此采用参数化方案：

```
┌───────────────────────────────────────────────────────────────────┐
│                    PARAMETERIZATION APPROACH                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  QoderWorkInput (base-hook-input)                                 │
│  ├── instance 1: agentType=QoderWork,   logDir=.../qoder-work/    │
│  └── instance 2: agentType=QoderWorkCN, logDir=.../qoder-work-cn/ │
│                                                                   │
│  QoderWorkLogInput (base-session-input)                           │
│  ├── instance 1: agentType=QoderWork,   dataRoot=.../QoderWork    │
│  └── instance 2: agentType=QoderWorkCN, dataRoot=.../QoderWork CN │
│                                                                   │
│  QoderWorkSqliteInput (base-input)                                │
│  ├── instance 1: agentType=QoderWork,   dataRoot=.../QoderWork    │
│  └── instance 2: agentType=QoderWorkCN, dataRoot=.../QoderWork CN │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 1. ClientType 新增

```typescript
// src/types/client-type.ts
export enum ClientType {
  // ...existing
  QoderWorkCN = 'qoder-work-cn',
}
```

### 2. Agent 描述文件

```json
// agents.d/qoder-work-cn.json
{
  "id": "qoder-work-cn",
  "displayName": "QoderWork CN",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.qoderworkcn"],
    "commands": []
  },
  "hook": {
    "settingsPath": "~/.qoderworkcn/settings.json",
    "events": ["Stop"],
    "hookCommand": "$PILOT_DATA/hooks/qoderworkcn-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/qoder-work-cn/history"
  }
}
```

### 3. 参数化 Input Classes

#### QoderWorkInput (Hook JSONL)

当前 `agentType` 是硬编码为 `ClientType.QoderWork`。改为通过 constructor options 传入：

```typescript
interface QoderWorkInputOptions extends Partial<HookInputOptions> {
  stateStore: HookInputOptions['stateStore'];
  agentType?: ClientType;  // 新增，默认 QoderWork
  detectionPath?: string;  // 新增，默认 ~/.qoderwork
}
```

- `id` 属性改为 computed: `${agentType}-hook`
- `checkAvailability()` 和 `getWatchPaths()` 改为实例方法（或接收参数的静态工厂）
- `transformRecord` 中的 `ClientType.QoderWork` 替换为 `this.agentType`

#### QoderWorkLogInput (SDK Log)

当前 `resolveQoderWorkRoot()` 返回固定路径。改为：

```typescript
interface QoderWorkLogInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  dataRoot?: string;       // 已有
  agentType?: ClientType;  // 新增，默认 QoderWork
}
```

- `id` 属性改为 computed: `${agentType}-log`
- 静态方法 `getWatchPaths()` / `checkAvailability()` 改为接收 dataRoot 参数的工厂
- `finalizeTurn` / `handleEvent` 中的 `ClientType.QoderWork` 替换为 `this.agentType`

#### QoderWorkSqliteInput (SQLite)

同理：

```typescript
interface QoderWorkSqliteInputOptions extends InputOptions {
  dbPath?: string;         // 已有
  dataRoot?: string;       // 已有
  agentType?: ClientType;  // 新增，默认 QoderWork
}
```

- `id` 属性改为 computed: `${agentType}-sqlite`
- `ClientType.QoderWork` 替换为 `this.agentType`

### 4. Hook 脚本

新建 `assets/hooks/qoderworkcn-loongsuite-pilot-hook.sh`，内容与 `qoderwork-loongsuite-pilot-hook.sh` 基本相同，仅默认 `AGENT_ID` 改为 `qoder-work-cn`。

### 5. 路径解析

新增 `resolveQoderWorkCNRoot()` helper 或将现有 `resolveQoderWorkRoot()` 参数化：

```typescript
function resolveQoderWorkRoot(variant: 'standard' | 'cn' = 'standard'): string {
  const dirName = variant === 'cn' ? 'QoderWork CN' : 'QoderWork';
  if (process.platform === 'darwin') {
    return resolveHome(`~/Library/Application Support/${dirName}`);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, dirName);
  return resolveHome(`~/.config/${dirName}`);
}
```

### 6. Orchestrator / Config-Loader 注册

在 orchestrator 发现 `~/.qoderworkcn` 时，实例化三个 CN 版 input：
- `new QoderWorkInput({ ..., agentType: ClientType.QoderWorkCN, logDir: '.../qoder-work-cn/history', detectionPath: '~/.qoderworkcn' })`
- `new QoderWorkLogInput({ ..., agentType: ClientType.QoderWorkCN, dataRoot: resolveQoderWorkRoot('cn') })`
- `new QoderWorkSqliteInput({ ..., agentType: ClientType.QoderWorkCN, dataRoot: resolveQoderWorkRoot('cn') })`

### 7. Agent System Map

在 `src/normalization/agent-system-map.ts` 中添加 `qoder-work-cn` 的 model/provider 映射（与 qoder-work 相同）。

### 8. 向后兼容

所有参数化改动使用默认值保持原有 QoderWork 行为不变：
- `agentType` 默认 `ClientType.QoderWork`
- `dataRoot` 默认 `resolveQoderWorkRoot('standard')`
- `detectionPath` 默认 `~/.qoderwork`

### Baseline Documentation Sync

实现完成后需同步更新：
- `docs/modules/inputs.md`：说明 QoderWork input classes 支持参数化变体
- `docs/modules/hooks.md`：运行时布局增加 `qoder-work-cn/history/`
