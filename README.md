# 多 AI Agent 轻量数据采集器

面向多种 AI Agent 的使用数据采集平台，支持自动发现、多种采集方式、多目标数据输出，架构高度可扩展。

## 环境依赖

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 16.x | 运行时，推荐 18 LTS 或更高 |
| npm | >= 8.x | 包管理器 |
| TypeScript | >= 5.3 | 开发依赖，已在 devDependencies 中声明 |
| better-sqlite3 | 9.x | 原生模块，需要编译工具链 (macOS: Xcode CLT, Linux: build-essential) |

```bash
# 验证环境
node -v   # >= v16.0.0
npm -v    # >= 8.0.0
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 编译 TypeScript
npm run build

# 3. 运行
npm start
```

## 编译

```bash
# 完整编译（输出到 dist/）
npm run build

# 仅类型检查（不生成文件）
npm run typecheck
```

编译产物输出到 `dist/` 目录，包含 `.js`、`.d.ts`、`.js.map` 三类文件，保持与 `src/` 相同的目录结构。

## 打包部署

### 方式一：直接部署编译产物

```bash
npm run build

# 将以下内容部署到目标机器
# ├── dist/           # 编译后的 JS
# ├── node_modules/   # 依赖（或目标机器上重新 npm install --production）
# └── package.json

# 在目标机器上运行
node dist/index.js
```

### 方式二：npm pack 打包

```bash
npm run build
npm pack
# 生成 ai-agent-collector-1.0.0.tgz
# 目标机器上: npm install -g ai-agent-collector-1.0.0.tgz
# 运行: ai-agent-collector
```

### 方式三：Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

### 方式四：systemd 守护进程

```ini
[Unit]
Description=Agent Data Collection
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/ai-agent-collector/dist/index.js
Restart=always
Environment=AAC_ENABLED=true

[Install]
WantedBy=multi-user.target
```

## 配置

支持**配置文件**和**环境变量**两种方式，优先级：环境变量 > 配置文件 > 内置默认值。

### 配置文件

默认路径 `~/.r2c/config.json`，可通过 `AGENT_DATA_COLLECTION_CONFIG` 环境变量指定其他路径。

```json
{
  "enabled": true,
  "dataDir": "~/.r2c",
  "port": 43124,

  "sls": {
    "enabled": true,
    "accessKeyId": "LTAI5t...",
    "accessKeySecret": "xxxxxxxx",
    "region": "cn-hangzhou",
    "endpoints": [
      {
        "name": "agent-activity",
        "project": "my-ai-analytics",
        "logstore": "agent-activity",
        "kind": "agentActivity"
      },
      {
        "name": "agent-telemetry",
        "project": "my-ai-analytics",
        "logstore": "agent-telemetry-telemetry",
        "kind": "agentTelemetry",
        "redact": true
      }
    ],
    "batchMaxSize": 20,
    "flushIntervalMs": 2000
  },

  "jsonl": {
    "enabled": true,
    "outputDir": "~/.r2c/logs/output",
    "rotateDaily": true,
    "maxFileSizeMb": 100
  },

  "http": {
    "enabled": true,
    "url": "https://my-report-server.com/api/trace",
    "headers": { "Authorization": "Bearer xxx" },
    "batchMaxSize": 20,
    "flushIntervalMs": 5000,
    "requestTimeoutMs": 10000
  },

  "listeners": {
    "qoder":          { "enabled": true, "pollInterval": 60000 },
    "qoder-work":     { "enabled": true, "pollInterval": 60000 },
    "qoder-cli-hook": { "enabled": true, "pollInterval": 60000 },
    "openclaw":       { "enabled": true, "pollInterval": 30000 }
  }
}
```

> AK/SK 等敏感信息建议通过环境变量传入，配置文件中只放非敏感项。

### 环境变量

环境变量会**覆盖**配置文件中的同名字段：

#### 全局控制

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `AGENT_DATA_COLLECTION_CONFIG` | 配置文件路径 | `~/.r2c/config.json` |
| `AAC_ENABLED` | 总开关 | `true` |
| `AAC_DATA_DIR` | 数据根目录 | `~/.r2c` |
| `AAC_DISCOVERY_INTERVAL_MS` | Agent 发现轮询间隔 | `300000` (5min) |
| `AAC_FORCE_POLLING` | 强制轮询（禁用 fs.watch） | `false` |
| `LOG_LEVEL` | 日志级别 (debug/info/warn/error) | `info` |
| `AAC_PORT` | HTTP 服务端口（预留） | `43124` |

#### SLS（阿里云日志服务）

使用 `@alicloud/log` 官方 SDK，AK/SK 同时配置后自动启用：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `SLS_ACCESS_KEY_ID` | AccessKey ID | 空 |
| `SLS_ACCESS_KEY_SECRET` | AccessKey Secret | 空 |
| `SLS_REGION` | SLS 地域 | `cn-hangzhou` |
| `SLS_PROJECT` | Agent 活动数据 Project | 空 |
| `SLS_LOGSTORE` | Agent 活动数据 Logstore | 空 |
| `SLS_AGENT_TELEMETRY_PROJECT` | Agent 遥测 Project（脱敏） | 空 |
| `SLS_AGENT_TELEMETRY_LOGSTORE` | Agent 遥测 Logstore（脱敏） | 空 |

#### JSONL / HTTP

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `JSONL_ENABLED` | 是否启用 JSONL 输出 | `true` |
| `JSONL_OUTPUT_DIR` | JSONL 文件输出目录 | `~/.r2c/logs/output` |
| `HTTP_REPORT_URL` | HTTP 上报地址（设置后启用） | 空 |
| `HTTP_REPORT_HEADERS` | 自定义请求头 (JSON string) | 空 |

#### 采集器轮询间隔

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `QODER_ANALYTICS_POLL_INTERVAL` | Qoder IDE 采集间隔 (ms) | `60000` |

## 项目结构

```
src/
├── index.ts                             # 主入口 + 默认配置 + 公共导出
├── types/                               # 类型定义层
│   ├── client-type.ts                   #   ClientType / CollectionMethod 枚举
│   ├── events.ts                        #   AgentActivityEntry / SessionRecord 等数据结构
│   └── index.ts                         #   统一导出 + Config 类型
├── utils/                               # 工具函数
│   ├── logger.ts                        #   结构化日志
│   ├── git-resolver.ts                  #   Git 仓库信息解析
│   └── fs-utils.ts                      #   文件系统操作
├── persistence/                         # ★ 持久化层（状态管理）
│   ├── snapshot-store.ts                #   快照去重 (pending/processed 状态机)
│   └── state-store.ts                   #   采集器偏移量/游标状态
├── normalization/                       # 归一化层
│   ├── entry-builder.ts                 #   构建统一 AgentActivityEntry + 序列化 + 脱敏
│   └── payload-normalizer.ts            #   HTTP/Hook 原始载荷标准化
├── reporters/                           # 数据输出层 (3 种输出目标)
│   ├── base-reporter.ts                 #   抽象 Reporter 接口
│   ├── sls-reporter.ts                  #   SLS 上报 (批量/健康检查/重试)
│   ├── jsonl-reporter.ts                #   本地 JSONL 文件 (按日轮转)
│   ├── http-reporter.ts                 #   HTTP POST 到外部服务
│   └── multi-reporter.ts               #   多目标扇出
├── collectors/                          # 采集器层
│   ├── base/                            #   ★ 6 种采集方式基类
│   │   ├── base-collector.ts            #     根抽象类 (生命周期/定时/事件)
│   │   ├── base-ide-collector.ts        #     IDE 历史快照轮询
│   │   ├── base-sqlite-collector.ts     #     SQLite 增量轮询
│   │   ├── base-hook-collector.ts       #     Hook JSONL 日志
│   │   ├── base-cli-forwarder.ts        #     CLI 遥测日志转发
│   │   ├── base-session-collector.ts    #     会话文件轮询
│   │   └── base-http-push-collector.ts  #     HTTP 推送接收
│   ├── qoder/                           #   Qoder IDE (快照轮询)
│   ├── qoder-work/                      #   Qoder Work (SQLite 轮询)
│   ├── qoder-cli/                       #   Qoder CLI (Hook JSONL)
│   └── openclaw/                        #   Openclaw — 新 Agent 示例 (会话文件轮询)
├── core/                                # 核心编排层
│   ├── orchestrator.ts                  #   中枢编排器 (串联所有子系统)
│   ├── collector-manager.ts             #   采集器生命周期 + Git 富化 + 分发
│   ├── agent-discovery-service.ts       #   Agent 发现 (fs.watch + 轮询 + 状态机)
│   ├── agent-control-manager.ts         #   Agent 控制 (三层准入策略 on/off/auto)
│   └── config-loader.ts                 #   配置加载 (环境变量 + 配置文件 + 默认值)
├── server/
│   └── http-server.ts                   #   本地 HTTP 服务 (预留，暂未启用)
└── hooks/
    └── hook-manager.ts                  #   Hook 脚本注入/卸载管理
```

## 持久化层（Persistence）

持久化层负责在进程重启之间保存采集状态，避免数据重复采集或丢失。包含两个核心组件：

### StateStore - 采集器状态存储

**作用**：保存每个采集器的进度状态，支持增量采集。

**存储位置**：`~/.r2c/logs/collector-state.json`

**状态字段**：
```typescript
interface CollectorState {
  lastOffset?: number;      // 文件读取偏移量（Hook/Session 采集器使用）
  lastRowId?: number;       // SQLite 行 ID（SQLite 采集器使用）
  lastTimestamp?: number;   // 最后处理的时间戳
  highWatermark?: number;   // 高水位线（已处理的最大时间戳）
  extra?: Record<string, unknown>;  // 自定义扩展字段（如文件 inode）
}
```

**使用场景**：
- **Hook JSONL 采集器**：记录文件读取字节偏移，避免重复读取
- **SQLite 采集器**：记录最后查询的 rowid，实现增量查询
- **Session 采集器**：记录文件偏移量和 inode（检测文件替换）
- **CLI Forwarder**：记录遥测日志文件的读取位置

**API 示例**：
```typescript
// 获取/设置偏移量
const offset = stateStore.getOffset('qoder-cli-hook');
stateStore.setOffset('qoder-cli-hook', 1024);

// 获取/设置 rowid
const rowId = stateStore.getRowId('qoder-work');
stateStore.setRowId('qoder-work', 12345);

// 通用状态更新
stateStore.update('my-collector', { 
  lastTimestamp: Date.now(),
  extra: { customField: 'value' }
});
```

**工作流程**：
1. **启动时**：从 JSON 文件加载状态到内存（Map）
2. **运行时**：采集器更新状态，标记 dirty
3. **停止时**：仅在 dirty 时写入文件（优化 I/O）

### SnapshotStore - 快照去重存储

**作用**：防止 IDE 历史快照采集器重复处理相同的文件修改事件。

**存储位置**：`~/.r2c/logs/snapshot-store.json`

**核心机制**：基于 `pending/processed` 状态机的去重逻辑。

#### 应用场景：VSCode-style 文件编辑历史快照

Qoder IDE（基于 VSCode 架构）会自动保存用户的文件编辑历史，存储在：

```
~/Library/Application Support/Qoder/User/History/
├── abc12345/
│   └── entries.json    # 记录文件的所有修改快照
├── def67890/
│   └── entries.json
└── ...
```

每个 `entries.json` 的结构：
```json
{
  "resource": "/path/to/original/file.ts",
  "entries": [
    {
      "id": "snapshot-001",
      "timestamp": 1714000000000,
      "source": "Qoder AI Assistant"  // AI 生成的修改
    },
    {
      "id": "snapshot-002",
      "timestamp": 1714000001000,
      "source": "User Manual Edit"     // 用户手动修改（会被过滤）
    }
  ]
}
```

**为什么需要去重？**

采集器定期轮询（例如每 60 秒），但历史快照文件会持久保留在磁盘上：

```
时间线：
T0 (00:00)  → 扫描发现 file.ts@@1714000000000 → 处理并上报
T1 (01:00)  → 再次扫描，同一个快照还在 entries.json 中
              ↓
              如果不去重 → 重复上报！❌
              使用 SnapshotStore → shouldProcess() 返回 false → 跳过 ✅
```

**去重 Key 的构建**：
```typescript
const key = `${event.filePath}@@${event.sourceTimestamp}@@${event.agentType}`;
// 例如："/path/to/file.ts@@1714000000000@@qoder"
```

三元组保证唯一性：
- `filePath`: 文件路径
- `sourceTimestamp`: 快照时间戳
- `agentType`: Agent 类型（qoder/qoder-work 等）

**快照条目结构**：
```typescript
interface SnapshotEntry {
  key: string;           // 唯一键（例如："filePath@@timestamp@@agentType"）
  timestamp: number;     // 事件时间戳
  seenAt: number;        // 首次发现时间（用于过期清理）
  status: 'pending' | 'processed';  // 处理状态
  reason?: string;       // 处理结果说明（可选）
}
```

**去重流程**：
```typescript
// 1. 检查是否应该处理（不存在于存储中）
if (!snapshotStore.shouldProcess(key)) {
  continue;  // 已处理过，跳过
}

// 2. 标记为 pending（开始处理）
snapshotStore.markPending(key, timestamp);

// 3. 处理数据...
const entry = await buildEntry(event);

// 4. 标记为 processed（处理完成）
snapshotStore.markProcessed(key, 'success');
```

**高水位线机制**：
- 自动追踪所有 `processed` 状态的最大时间戳
- 重启时从 `highWatermark` 开始扫描，跳过已处理的数据
- 结合 `retentionMs`（默认 7 天）自动清理过期条目

**API 示例**：
```typescript
// 获取建议的起始时间戳（重启后使用）
const sinceTs = snapshotStore.getSuggestedSinceTimestamp();
// 返回: Math.max(highWatermark, Date.now() - 7天)

// 批量清理过期条目（自动在 flush 时调用）
// 超过 retentionMs 的条目会被删除
```

### 两个 Store 的对比

| 特性 | StateStore | SnapshotStore |
|------|-----------|---------------|
| **用途** | 采集进度跟踪 | 事件去重 |
| **粒度** | 每个采集器一条记录 | 每个事件一条记录 |
| **数据量** | 小（几个 KB） | 较大（随事件增长） |
| **清理策略** | 不清理 | 自动清理过期条目（7天） |
| **使用场景** | Hook/SQLite/Session 采集 | IDE 快照采集 |
| **关键字段** | offset/rowid | key/status/highWatermark |

### 持久化文件示例

**collector-state.json**：
```json
{
  "qoder-cli-hook": {
    "lastOffset": 15234
  },
  "qoder-work": {
    "lastRowId": 8921
  },
  "openclaw": {
    "lastOffset": 4521,
    "extra": {
      "inode": 12345678
    }
  }
}
```

**snapshot-store.json**：
```json
{
  "highWatermark": 1714000000000,
  "entries": [
    {
      "key": "/path/to/file.ts@@1714000000000@@qoder",
      "timestamp": 1714000000000,
      "seenAt": 1714000100000,
      "status": "processed",
      "reason": "success"
    }
  ]
}
```

## 采集方式与对应基类

| 采集方式 | 基类 | 原理 | 示例 Agent |
|---------|------|------|-----------|
| IDE 历史快照轮询 | `BaseIdeCollector` | 定时读取 IDE 本地 DiskKV/历史文件 | Qoder |
| SQLite 增量轮询 | `BaseSqliteCollector` | 增量查询本地 SQLite (rowid 游标) | Qoder Work |
| Hook JSONL 日志 | `BaseHookCollector` | 注入 Hook 脚本拦截事件，读 JSONL | Qoder CLI |
| CLI 遥测日志转发 | `BaseCliForwarder` | 配置 Agent 遥测输出到文件，轮询转发 | (Gemini 模式) |
| 会话文件轮询 | `BaseSessionCollector` | 读取 JSONL/JSON 会话记录文件 | Openclaw |
| HTTP 推送接收 | `BaseHttpPushCollector` | 本地 HTTP 服务接收 Agent 主动推送 | (外部 Agent) |

## 数据输出

系统通过 `MultiReporter` 同时输出到多个目标：

| 输出目标 | 类 | 说明 |
|---------|---|------|
| SLS | `SlsReporter` | 阿里云日志服务，批量(20条/2秒)，健康检查，失败重试 |
| JSONL | `JsonlReporter` | 本地文件，按 `{clientType}-{YYYY-MM-DD}.jsonl` 轮转 |
| HTTP | `HttpReporter` | POST 到指定服务，批量发送，自动重试 |

## 扩展指南

### 新增一个 Agent

以 Openclaw 为例，添加一个新的 AI Agent 采集只需 **3 步**：

#### 场景 A：数据格式一致（使用现有基类）

如果新 Agent 的数据格式与现有采集方式匹配（如 JSONL 会话文件、SQLite、Hook JSONL 等），直接参考下面的 3 步即可。

#### 场景 B：数据格式不一致（需要自定义归一化）

如果新 Agent 的数据格式特殊，需要额外的转换逻辑，需要添加以下文件：

```
src/
├── collectors/
│   └── my-new-agent/
│       └── my-new-agent-collector.ts      # ① 实现 Collector（数据采集）
├── normalization/
│   └── my-new-agent-normalizer.ts         # ② 自定义归一化器（数据格式转换）
└── types/
    └── my-new-agent-types.ts              # ③ 类型定义（可选，如数据结构复杂）
```

**步骤说明：**

1. **创建 Collector**（必须）
   - 选择合适的基类继承（或直接从 `BaseCollector` 继承）
   - 实现数据采集逻辑，返回原始数据
   
2. **创建归一化器**（数据格式不一致时必须）
   ```typescript
   // src/normalization/my-new-agent-normalizer.ts
   import type { AgentActivityEntry } from '../types/index.js';
   import { buildAgentActivityEntry } from './entry-builder.js';
   
   export interface RawMyNewAgentPayload {
     // 定义新 Agent 的原始数据格式
     session_id: string;
     event_type: string;
     // ... 其他字段
   }
   
   export function normalizeMyNewAgentPayload(
     payload: RawMyNewAgentPayload,
   ): AgentActivityEntry {
     // 将特殊格式转换为标准的 AgentActivityEntry
     return buildAgentActivityEntry({
       sessionId: payload.session_id,
       userId: '',
       agentType: ClientType.MyNewAgent,
       actionType: normalizeActionType(payload.event_type),
       filePath: extractFilePath(payload),
       content: extractContent(payload),
       // ... 其他字段映射
     });
   }
   ```

3. **在 Collector 中使用归一化器**
   ```typescript
   // src/collectors/my-new-agent/my-new-agent-collector.ts
   import { normalizeMyNewAgentPayload } from '../../normalization/my-new-agent-normalizer.js';
   
   // 在数据处理时调用
   const entry = normalizeMyNewAgentPayload(rawData);
   ```

4. **类型定义**（可选）
   - 如果数据结构复杂，建议在 `types/` 下单独定义
   - 简单结构可以直接写在 collector 或 normalizer 中

#### 第 1 步：声明 ClientType

在 `src/types/client-type.ts` 的 `ClientType` 枚举中添加：

```typescript
export enum ClientType {
  // ... existing ...
  MyNewAgent = 'my-new-agent',
}
```

#### 第 2 步：实现 Collector

选择合适的基类，实现少量抽象方法。例如，若新 Agent 产生 JSONL 会话文件：

```typescript
// src/collectors/my-new-agent/my-new-agent-collector.ts
import { ClientType } from '../../types/index.js';
import { BaseSessionCollector, type SessionCollectorOptions } from '../base/base-session-collector.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

export class MyNewAgentCollector extends BaseSessionCollector {
  readonly id = 'my-new-agent';
  readonly clientType = ClientType.MyNewAgent;

  constructor(opts: { stateStore: SessionCollectorOptions['stateStore'] }) {
    super({
      stateStore: opts.stateStore,
      sessionDir: resolveHome('~/.my-new-agent/sessions'),
      filePattern: 'session-*.jsonl',
      pollIntervalMs: 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.my-new-agent'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.my-new-agent')];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    // 返回要扫描的文件路径列表
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // 将一条 JSON 记录转换为 AgentActivityEntry，无关事件返回 null
  }
}
```

每个基类只需实现 2-3 个抽象方法：

| 基类 | 需要实现的方法 |
|------|--------------|
| `BaseIdeCollector` | `scanHistoryEntries()`, `buildEntry()` |
| `BaseSqliteCollector` | `readNewRows()`, `transformRow()` |
| `BaseHookCollector` | `transformRecord()` |
| `BaseCliForwarder` | `isRelevantEvent()`, `transformPayload()` |
| `BaseSessionCollector` | `discoverSessionFiles()`, `processSessionLine()` |
| `BaseHttpPushCollector` | (可选) `transformPushPayload()` |

#### 第 3 步：注册到 Orchestrator

在 `src/core/orchestrator.ts` 的 `registerAllCollectors()` 方法中添加：

```typescript
import { MyNewAgentCollector } from '../collectors/my-new-agent/my-new-agent-collector.js';

// 在 registerAllCollectors() 中:
const myCollector = new MyNewAgentCollector({ stateStore: this.stateStore });
this.collectorManager.registerCollector(myCollector);
entries.push(
  this.collectorManager.buildDetectionEntry(myCollector, {
    watchPaths: MyNewAgentCollector.getWatchPaths(),
    isAvailable: MyNewAgentCollector.checkAvailability,
    enabled: () => this.agentControlManager.resolveEnabled('my-new-agent', true),
  }),
);
```

完成后重新编译即可。系统会自动发现 Agent 安装、管理生命周期、输出到所有已配置的目标。

### 新增输出目标

继承 `BaseReporter` 并实现 `send` / `sendBatch` / `flush` / `shutdown`，然后在 `orchestrator.ts` 的 `buildReporter()` 中添加到 reporters 数组。

### 调整准入策略

编辑 `~/.r2c/agent-control.json` 文件：

```json
{
  "version": 3,
  "tools": {
    "qoder": "auto",
    "qoder-work": "on",
    "qoder-cli-hook": "off",
    "openclaw": "auto"
  }
}
```

模式说明：
- `"on"` - 强制启用
- `"off"` - 强制禁用
- `"auto"` - 自动检测（默认）

## License

Private / Internal Use
