# 多 AI Agent 轻量数据输入源

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

## 本地开发与测试

### 开发环境准备

```bash
# 1. 克隆仓库
git clone <repository-url>
cd agent-data-collection

# 2. 安装依赖（包含 postinstall 钩子脚本安装）
npm install

# 3. 类型检查（推荐在编码过程中使用）
npm run typecheck
```

### 编译与运行

```bash
# 完整编译（输出到 dist/）
npm run build

# 启动服务（开发环境）
npm start
# 等价于: node dist/index.js
```

### 开发最佳实践

1. **增量编译**：修改代码后重新运行 `npm run build`，或启用 TypeScript watch 模式：
   ```bash
   npx tsc --watch
   ```

2. **直接运行测试**：编译后直接运行测试：
   ```bash
   node dist/index.js
   ```

3. **验证钩子安装**：检查 `~/.ai-agent-collector/hooks/` 目录确认 hook 脚本已正确安装：
   ```bash
   ls -la ~/.ai-agent-collector/hooks/
   ```

4. **查看日志输出**：检查数据采集日志：
   ```bash
   tail -f ~/.ai-agent-collector/logs/output/*.jsonl
   ```

## 打包发布

### 构建发布包（最佳实践）

```bash
# 1. 清理并重新编译
npm run build

# 2. 打包为 npm tarball（自动包含 files 中声明的内容）
npm pack
# 生成: ai-agent-collector-1.0.0.tgz
```

**打包内容说明**（由 `package.json` 的 `files` 字段控制）：
```
ai-agent-collector-1.0.0.tgz
├── dist/              # 编译后的 JavaScript 代码
├── assets/            # Hook 脚本等资源文件
├── scripts/           # postinstall 安装脚本
└── package.json       # 包元信息
```

### 发布到 npm 仓库（可选）

```bash
# 1. 更新版本号
npm version patch  # 或 minor, major

# 2. 发布到 npm registry
npm publish

# 3. 验证发布
cd /tmp && npm install ai-agent-collector
```

## 线上部署（主机场景）

### 方式一：npm 包安装（推荐）

```bash
# 安装已发布的 npm 包
npm install -g ai-agent-collector

# 或直接安装本地打包的 tarball
npm install -g ai-agent-collector-1.0.0.tgz

# 验证安装（自动执行 postinstall，安装 hook 脚本）
ai-agent-collector --version

# 配置环境变量（按需）
export AAC_ENABLED=true
export SLS_ACCESS_KEY_ID="your-key"
export SLS_ACCESS_KEY_SECRET="your-secret"

# 启动服务（后台运行）
nohup ai-agent-collector > /var/log/ai-agent-collector.log 2>&1 &
```

### 方式二：编译产物部署

```bash
# 在构建机器上编译
git clone <repository-url>
cd agent-data-collection
npm ci --production
npm run build

# 将以下目录同步到目标主机：
# ├── dist/           # 编译产物
# ├── node_modules/   # 生产依赖（或到目标机器执行 npm install --production）
# ├── assets/         # Hook 脚本
# ├── scripts/        # postinstall 脚本
# └── package.json

# 在目标主机上
cd /opt/ai-agent-collector
npm install --production  # 安装依赖并执行 postinstall（如果同步了完整目录）

# 配置并启动
cat > /opt/ai-agent-collector/.env << EOF
AAC_ENABLED=true
SLS_ACCESS_KEY_ID=your-key
SLS_ACCESS_KEY_SECRET=your-secret
EOF

node dist/index.js &
```

### 生产环境守护（systemd）

创建服务文件 `/etc/systemd/system/ai-agent-collector.service`：

```ini
[Unit]
Description=AI Agent Collector
After=network.target

[Service]
Type=simple
User=collector
WorkingDirectory=/opt/ai-agent-collector
ExecStart=/usr/bin/node /opt/ai-agent-collector/dist/index.js
Restart=always
RestartSec=10
Environment=AAC_ENABLED=true
# 或通过 EnvironmentFile 加载配置:
# EnvironmentFile=/opt/ai-agent-collector/.env

# 日志输出（可通过 journalctl 查看）
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启动并管理服务：

```bash
# 重载 systemd 配置
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start ai-agent-collector

# 设置开机自启
sudo systemctl enable ai-agent-collector

# 查看状态
sudo systemctl status ai-agent-collector

# 查看日志
sudo journalctl -u ai-agent-collector -f
```

## 配置

支持**配置文件**和**环境变量**两种方式，优先级：环境变量 > 配置文件 > 内置默认值。

### 配置文件

默认路径 `~/.ai-agent-collector/config.json`，可通过 `AGENT_DATA_COLLECTION_CONFIG` 环境变量指定其他路径。

```json
{
  "enabled": true,
  "dataDir": "~/.ai-agent-collector",
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
    "outputDir": "~/.ai-agent-collector/logs/output",
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
| `AGENT_DATA_COLLECTION_CONFIG` | 配置文件路径 | `~/.ai-agent-collector/config.json` |
| `AAC_ENABLED` | 总开关 | `true` |
| `AAC_DATA_DIR` | 数据根目录 | `~/.ai-agent-collector` |
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
| `JSONL_OUTPUT_DIR` | JSONL 文件输出目录 | `~/.ai-agent-collector/logs/output` |
| `HTTP_REPORT_URL` | HTTP 上报地址（设置后启用） | 空 |
| `HTTP_REPORT_HEADERS` | 自定义请求头 (JSON string) | 空 |

#### 输入源轮询间隔

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
├── checkpoint/                         # ★ 持久化层（状态管理）
│   ├── snapshot-store.ts                #   快照去重 (pending/processed 状态机)
│   └── state-store.ts                   #   输入源偏移量/游标状态
├── normalization/                       # 归一化层
│   ├── entry-builder.ts                 #   构建统一 AgentActivityEntry + 序列化 + 脱敏
│   └── payload-normalizer.ts            #   HTTP/Hook 原始载荷标准化
├── flushers/                           # 数据输出层 (3 种输出通道)
│   ├── base-flusher.ts                 #   抽象 Flusher 接口
│   ├── sls-flusher.ts                  #   SLS 上报 (批量/健康检查/重试)
│   ├── jsonl-flusher.ts                #   本地 JSONL 文件 (按日轮转)
│   ├── http-flusher.ts                 #   HTTP POST 到外部服务
│   └── multi-flusher.ts               #   多目标扇出
├── inputs/                          # 输入源层
│   ├── base/                            #   ★ 6 种采集方式基类
│   │   ├── base-input.ts            #     根抽象类 (生命周期/定时/事件)
│   │   ├── base-ide-input.ts        #     IDE 历史快照轮询
│   │   ├── base-sqlite-input.ts     #     SQLite 增量轮询
│   │   ├── base-hook-input.ts       #     Hook JSONL 日志
│   │   ├── base-cli-forwarder.ts        #     CLI 遥测日志转发
│   │   └── base-session-input.ts    #     会话文件轮询
│   ├── qoder/                           #   Qoder IDE (快照轮询)
│   ├── qoder-work/                      #   Qoder Work (SQLite 轮询)
│   ├── qoder-cli/                       #   Qoder CLI (Hook JSONL)
│   └── openclaw/                        #   Openclaw — 新 Agent 示例 (会话文件轮询)
├── core/                                # 核心编排层
│   ├── orchestrator.ts                  #   中枢编排器 (串联所有子系统)
│   ├── input-manager.ts             #   输入源生命周期 + Git 富化 + 分发
│   ├── agent-discovery-service.ts       #   Agent 发现 (fs.watch + 轮询 + 状态机)
│   ├── agent-control-manager.ts         #   Agent 控制 (三层准入策略 on/off/auto)
│   └── config-loader.ts                 #   配置加载 (环境变量 + 配置文件 + 默认值)
├── server/
│   └── http-server.ts                   #   本地 HTTP 服务 (预留，暂未启用)
└── hooks/
    └── hook-manager.ts                  #   Hook 脚本注入/卸载管理
```

## 持久化层（Checkpoint）

持久化层负责在进程重启之间保存采集状态，避免数据重复采集或丢失。包含两个核心组件：

### StateStore - 输入源状态存储

**作用**：保存每个输入源的进度状态，支持增量采集。

**存储位置**：`~/.ai-agent-collector/logs/input-state.json`

**状态字段**：
```typescript
interface InputState {
  lastOffset?: number;      // 文件读取偏移量（Hook/Session 输入源使用）
  lastRowId?: number;       // SQLite 行 ID（SQLite 输入源使用）
  lastTimestamp?: number;   // 最后处理的时间戳
  highWatermark?: number;   // 高水位线（已处理的最大时间戳）
  extra?: Record<string, unknown>;  // 自定义扩展字段（如文件 inode）
}
```

**使用场景**：
- **Hook JSONL 输入源**：记录文件读取字节偏移，避免重复读取
- **SQLite 输入源**：记录最后查询的 rowid，实现增量查询
- **Session 输入源**：记录文件偏移量和 inode（检测文件替换）
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
stateStore.update('my-input', { 
  lastTimestamp: Date.now(),
  extra: { customField: 'value' }
});
```

**工作流程**：
1. **启动时**：从 JSON 文件加载状态到内存（Map）
2. **运行时**：输入源更新状态，标记 dirty
3. **停止时**：仅在 dirty 时写入文件（优化 I/O）

### SnapshotStore - 快照去重存储

**作用**：防止 IDE 历史快照输入源重复处理相同的文件修改事件。

**存储位置**：`~/.ai-agent-collector/logs/snapshot-store.json`

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

输入源定期轮询（例如每 60 秒），但历史快照文件会持久保留在磁盘上：

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
| **粒度** | 每个输入源一条记录 | 每个事件一条记录 |
| **数据量** | 小（几个 KB） | 较大（随事件增长） |
| **清理策略** | 不清理 | 自动清理过期条目（7天） |
| **使用场景** | Hook/SQLite/Session 采集 | IDE 快照采集 |
| **关键字段** | offset/rowid | key/status/highWatermark |

### 持久化文件示例

**input-state.json**：
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
| IDE 历史快照轮询 | `BaseIdeInput` | 定时读取 IDE 本地 DiskKV/历史文件 | Qoder |
| SQLite 增量轮询 | `BaseSqliteInput` | 增量查询本地 SQLite (rowid 游标) | Qoder Work |
| Hook JSONL 日志 | `BaseHookInput` | 注入 Hook 脚本拦截事件，读 JSONL | Qoder CLI |
| CLI 遥测日志转发 | `BaseCliForwarder` | 配置 Agent 遥测输出到文件，轮询转发 | (Gemini 模式) |
| 会话文件轮询 | `BaseSessionInput` | 读取 JSONL/JSON 会话记录文件 | Openclaw |

## 数据输出

系统通过 `MultiFlusher` 同时输出到多个目标：

| 输出通道 | 类 | 说明 |
|---------|---|------|
| SLS | `SlsFlusher` | 阿里云日志服务，批量(20条/2秒)，健康检查，失败重试 |
| JSONL | `JsonlFlusher` | 本地文件，按 `{clientType}-{YYYY-MM-DD}.jsonl` 轮转 |
| HTTP | `HttpFlusher` | POST 到指定服务，批量发送，自动重试 |

## 扩展指南

### 新增一个 Agent

以 Openclaw 为例，添加一个新的 AI Agent 采集只需 **3 步**：

#### 场景 A：数据格式一致（使用现有基类）

如果新 Agent 的数据格式与现有采集方式匹配（如 JSONL 会话文件、SQLite、Hook JSONL 等），直接参考下面的 3 步即可。

#### 场景 B：数据格式不一致（需要自定义归一化）

如果新 Agent 的数据格式特殊，需要额外的转换逻辑，需要添加以下文件：

```
src/
├── inputs/
│   └── my-new-agent/
│       └── my-new-agent-input.ts      # ① 实现 Input（数据采集）
├── normalization/
│   └── my-new-agent-normalizer.ts         # ② 自定义归一化器（数据格式转换）
└── types/
    └── my-new-agent-types.ts              # ③ 类型定义（可选，如数据结构复杂）
```

**步骤说明：**

1. **创建 Input**（必须）
   - 选择合适的基类继承（或直接从 `BaseInput` 继承）
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

3. **在 Input 中使用归一化器**
   ```typescript
   // src/inputs/my-new-agent/my-new-agent-input.ts
   import { normalizeMyNewAgentPayload } from '../../normalization/my-new-agent-normalizer.js';
   
   // 在数据处理时调用
   const entry = normalizeMyNewAgentPayload(rawData);
   ```

4. **类型定义**（可选）
   - 如果数据结构复杂，建议在 `types/` 下单独定义
   - 简单结构可以直接写在 input 或 normalizer 中

#### 第 1 步：声明 ClientType

在 `src/types/client-type.ts` 的 `ClientType` 枚举中添加：

```typescript
export enum ClientType {
  // ... existing ...
  MyNewAgent = 'my-new-agent',
}
```

#### 第 2 步：实现 Input

选择合适的基类，实现少量抽象方法。例如，若新 Agent 产生 JSONL 会话文件：

```typescript
// src/inputs/my-new-agent/my-new-agent-input.ts
import { ClientType } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

export class MyNewAgentInput extends BaseSessionInput {
  readonly id = 'my-new-agent';
  readonly clientType = ClientType.MyNewAgent;

  constructor(opts: { stateStore: SessionInputOptions['stateStore'] }) {
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
| `BaseIdeInput` | `scanHistoryEntries()`, `buildEntry()` |
| `BaseSqliteInput` | `readNewRows()`, `transformRow()` |
| `BaseHookInput` | `transformRecord()` |
| `BaseCliForwarder` | `isRelevantEvent()`, `transformPayload()` |
| `BaseSessionInput` | `discoverSessionFiles()`, `processSessionLine()` |

#### 第 3 步：注册到 Orchestrator

在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 方法中添加：

```typescript
import { MyNewAgentInput } from '../inputs/my-new-agent/my-new-agent-input.js';

// 在 registerAllInputs() 中:
const myInput = new MyNewAgentInput({ stateStore: this.stateStore });
this.inputManager.registerInput(myInput);
entries.push(
  this.inputManager.buildDetectionEntry(myInput, {
    watchPaths: MyNewAgentInput.getWatchPaths(),
    isAvailable: MyNewAgentInput.checkAvailability,
    enabled: () => this.agentControlManager.resolveEnabled('my-new-agent', true),
  }),
);
```

完成后重新编译即可。系统会自动发现 Agent 安装、管理生命周期、输出到所有已配置的目标。

### 新增输出通道

继承 `BaseFlusher` 并实现 `send` / `sendBatch` / `flush` / `shutdown`，然后在 `orchestrator.ts` 的 `buildFlusher()` 中添加到 flushers 数组。

### 调整准入策略

编辑 `~/.ai-agent-collector/agent-control.json` 文件：

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
