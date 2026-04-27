# Contract: Flusher 输出接口

**Module**: `src/flushers/`

## BaseFlusher 抽象接口

```typescript
abstract class BaseFlusher {
  abstract readonly name: string;

  abstract send(entry: AgentActivityEntry): Promise<void>;
  abstract sendBatch(entries: AgentActivityEntry[]): Promise<void>;
  abstract flush(): Promise<void>;
  abstract shutdown(): Promise<void>;
  async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void>;
}
```

## MultiFlusher 扇出行为

```typescript
class MultiFlusher extends BaseFlusher {
  // 并行分发，Promise.allSettled 隔离失败
  async send(entry): Promise<void>;
  async sendBatch(entries): Promise<void>;
  async flush(): Promise<void>;
  async shutdown(): Promise<void>;
  async sendRaw(topic, payload): Promise<void>;
}
```

**关键行为**:
- 所有操作使用 `Promise.allSettled`，单个 flusher 失败只记录 error 日志，不影响其他
- shutdown 对所有 flusher 并行执行

## JsonlFlusher 行为

| 操作 | 行为 |
|------|------|
| `send(entry)` | `serialiseLogEntry(entry)` → JSON.stringify → `appendLine(filePath, line)` |
| `sendBatch(entries)` | 逐条调用 `send` |
| `flush()` | No-op（JSONL 立即追加写入） |
| `shutdown()` | No-op |
| `sendRaw(topic, payload)` | 写入 `{topic}-{YYYY-MM-DD}.jsonl` |

**文件命名**: `{agentType}-{YYYY-MM-DD}.jsonl`（rotateDaily=true）或 `{agentType}-all.jsonl`

## SlsFlusher 行为

| 操作 | 行为 |
|------|------|
| `send(entry)` | 对每个 endpoint 序列化（可选脱敏）→ 入队 |
| `flush()` | 按 `(project, logstore)` 分组批量发送 `postLogStoreLogs` |
| `shutdown()` | 停止 flush 定时器 → 执行最后一次 flush |

**故障容错**: `postLogStoreLogs` 失败 → 将 logGroup 持久化到 `sls-failed-logs/{kind}.jsonl`

**批量控制**: `batchMaxSize`（默认 20）触发立即 flush；`flushIntervalMs`（默认 2s）定时 flush

## HttpFlusher 行为

| 操作 | 行为 |
|------|------|
| `send(entry)` | `serialiseLogEntry(entry)` → 推入 buffer |
| `sendBatch(entries)` | 批量推入 buffer |
| `flush()` | buffer 全部取出 → `axios.post(url, { entries: batch })` |
| `shutdown()` | 停止 flush 定时器 → 执行最后一次 flush |

**故障容错**: `axios.post` 失败 → `this.buffer.unshift(...batch)` 重新入队头部

## 新增 Flusher 的接入契约

1. 继承 `BaseFlusher`
2. 实现 `send`/`sendBatch`/`flush`/`shutdown` 四个方法
3. 在 `Orchestrator.buildFlusher()` 中根据配置实例化并加入 `MultiFlusher`
