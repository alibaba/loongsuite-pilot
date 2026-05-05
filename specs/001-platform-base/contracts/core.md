# Contract: 核心编排层接口

**Module**: `src/core/`

## Orchestrator 生命周期

```text
start():
  1. ensureDir(dataDir, dataDir/logs)
  2. stateStore.load()
  3. agentControlManager.load()
  4. buildFlusher() → MultiFlusher | single flusher | JSONL fallback
  5. inputManager.setFlusher(flusher)
  6. registerAllInputs() → AgentDetectionEntry[]
  7. agentDiscoveryService.start()
  8. isRunning = true, emit('started')

stop():
  1. agentDiscoveryService.stop()
  2. inputManager.stopAll()
  3. flusher.shutdown()
  4. stateStore.save()
  5. isRunning = false, emit('stopped')
```

**幂等性**: `start()` 在 `isRunning=true` 时直接返回；`stop()` 在 `isRunning=false` 时直接返回

## ConfigLoader 优先级

```text
环境变量 > 配置文件 (~/.loongsuite-pilot/config.json) > 内置默认值
```

| 环境变量 | 对应配置 | 默认值 |
|---------|---------|--------|
| `LOONGPILOT_ENABLED` | enabled | true |
| `LOONGPILOT_DATA_DIR` | dataDir | ~/.loongsuite-pilot |
| `LOONGPILOT_PORT` | port | 43124 |
| `SLS_ACCESS_KEY_ID` | sls.accessKeyId | '' |
| `SLS_ACCESS_KEY_SECRET` | sls.accessKeySecret | '' |
| `SLS_ENDPOINT` | sls.endpoint | '' |
| `SLS_PROJECT` / `SLS_LOGSTORE` | sls.endpoints[0] | — |
| `JSONL_ENABLED` | jsonl.enabled | true |
| `JSONL_OUTPUT_DIR` | jsonl.outputDir | {dataDir}/logs/output |
| `HTTP_REPORT_URL` | http.url | '' |
| `HTTP_REPORT_HEADERS` | http.headers | — |
| `AGENT_DATA_COLLECTION_CONFIG` | 配置文件路径 | ~/.loongsuite-pilot/config.json |

## AgentControlManager 三级模式

```typescript
resolveEnabled(agentId: string, defaultWhenAuto: boolean): boolean
```

| mode | 结果 |
|------|------|
| `'on'` | 始终返回 true |
| `'off'` | 始终返回 false |
| `'auto'` | 返回 defaultWhenAuto |

## AgentDiscoveryService 状态机

```text
  ┌──────┐
  │ idle │◀────────────────────────┐
  └──┬───┘                         │
     │ shouldRun=true              │ shouldRun=false || error
     ▼                             │
  ┌──────────┐                     │
  │ starting │──entry.start()───▶┌─┴──────┐
  └──────────┘                   │ running │
                                 └────┬────┘
                                      │ shouldRun=false
                                      ▼
                                 ┌──────────┐
                                 │ stopping  │──entry.stop()──▶ idle
                                 └──────────┘
```

**发现策略**: 
1. 优先 `fs.watch(watchPaths)` → 文件变化触发 `processEntry`
2. `fs.watch` 失败（路径不存在或 error）→ 自动降级 `setInterval` 轮询
3. 全局轮询定时器兜底（默认 5 分钟）
4. `LOONGPILOT_FORCE_POLLING=true` 强制轮询模式

## InputManager 事件分发

```typescript
registerInput(input):
  inputs.set(input.id, input)
  input.on('entries', handleEntries)

handleEntries(inputId, entries):
  for entry of entries:
    if !entry.userId → entry.userId = this.userId
  flusher.sendBatch(entries)
```
