# Module: flushers

> Last verified: 2026-05-13

## 职责 (Responsibility)

数据输出层，负责将标准化的 AgentActivityEntry 批量写入一个或多个后端存储目标。

## 公共接口 (Public Interface)

- **BaseFlusher** — 所有 Flusher 的抽象基类，定义了发送单条/批量、刷新缓冲、关闭等核心能力，并提供可选的 sendRaw 原始发送接口（默认 no-op）。
- **SlsFlusher** — 阿里云 SLS 输出实现，支持 AK 签名模式和 WebTracking 匿名模式，具备内部缓冲队列、定时刷新和重试机制。
- **JsonlFlusher** — 本地 JSONL 文件输出实现，每条立即追加写入，按 agentType + 日期分文件。
- **HttpFlusher** — 通用 HTTP POST 输出实现，具备内存缓冲和定时批量发送能力。
- **MultiFlusher** — 多目标输出组合器，将数据并行分发至多个子 flusher，单个失败不影响其他目标。

## 不负责 (NOT Responsible For)

- 数据采集 → inputs 模块负责
- 数据标准化/脱敏 → normalization 模块负责
- 决定何时刷新 → InputManager (core) 驱动
- 重试策略以外的错误处理 → 调用方负责

## 内部设计 (Internal Design)

### 写入策略

| Flusher | 缓冲 | 定时 Flush | 写入方式 |
|---------|------|-----------|---------|
| SlsFlusher | 按 endpoint 分 bucket 队列 | `flushIntervalMs` 定时 | AK 签名 / WebTracking HTTP POST |
| JsonlFlusher | 无 (每条立即写入) | — | `appendLine()` 追加到按 agentType + date 分的文件 |
| HttpFlusher | 内存 buffer | `flushIntervalMs` 定时 | axios POST batch |
| MultiFlusher | — | — | `Promise.allSettled` 并行分发到子 flushers |

### SlsFlusher 双模式
- **AK 模式** (`mode: 'ak'`)：使用 `@alicloud/log` SDK `postLogStoreLogs`
- **WebTracking 模式** (`mode: 'webtracking'`)：匿名 HTTP POST 到 `{project}.{endpoint}/logstores/{logstore}/track`

### 重试与容错
- **SlsFlusher**：最多 3 次指数退避重试；可重试状态码 408/429/500/502/503/504；失败后持久化到 `sls-failed-logs/` 目录
- **HttpFlusher**：失败后将 batch 放回 buffer 首部（re-queue）
- **MultiFlusher**：使用 `Promise.allSettled` 确保单个 flusher 失败不影响其他

### WebTracking 分片
按条数 (≤4096) 和体积 (≤2.8MB) 自动分片，确保不超 PutWebtracking 接口限制。

### Serialization
所有 flusher 通过 `serialiseLogEntry()` 将 `AgentActivityEntry` 转换为 `Record<string, string>` 扁平 KV 格式。SlsFlusher 支持对指定 endpoint 应用 `redactCodeGenerationFields()`。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AgentActivityEntry`, `SlsFlusherConfig`, `JsonlFlusherConfig`, `HttpFlusherConfig`, `SlsEndpoint` |
| normalization | `serialiseLogEntry`, `redactCodeGenerationFields` |
| utils | `createLogger`, `appendLine`, `ensureDir`, `getTodayDateString` |
| 外部库 | `@alicloud/log` (SlsFlusher), `axios` (HttpFlusher) |

## 扩展指南 (Extension Guide)

### 添加新输出目标

创建新 Flusher 需要继承 BaseFlusher 并实现发送/批量发送/刷新/关闭方法，然后在 Orchestrator 的 flusher builder 中注册。参考现有实现: [src/flushers/http-flusher.ts](../../src/flushers/http-flusher.ts)

步骤概要：
1. 创建文件 `src/flushers/my-flusher.ts`，继承 `BaseFlusher`
2. 在 `types/index.ts` 中添加对应 config interface
3. 在 `config-loader.ts` 中添加构建函数
4. 在 `Orchestrator.buildFlusher()` 中注册
5. 如有 batch/定时 flush 需求，在 `start()` 中创建 interval，`shutdown()` 中清理

## 约束 (Constraints)

1. **shutdown() 必须 flush 剩余缓冲**：确保进程退出前不丢数据。
2. **send/sendBatch 不得抛出未捕获异常到调用方**：错误应内部处理或 re-queue。
3. **MultiFlusher 使用 allSettled**：单个下游失败不得影响其他目标。
4. **sendRaw 为可选覆盖**：基类默认 no-op，仅 SLS/JSONL/HTTP 按需实现。
5. **序列化前必须经过 `serialiseLogEntry()`**：不得直接 JSON.stringify entry 发送。
6. **SlsFlusher 失败日志必须持久化**：写入 `sls-failed-logs/` 以供诊断和重试。
