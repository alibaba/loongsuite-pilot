# 数据输出层 (src/flushers/)

> 多目标扇出架构，采集数据同时输出到 SLS、本地 JSONL、HTTP 三个通道。

## 模块组成

| 文件 | 职责 |
|------|------|
| `base-flusher.ts` | 抽象基类，定义 Flusher 接口 |
| `sls-flusher.ts` | 阿里云日志服务输出（批量/重试/健康检查） |
| `jsonl-flusher.ts` | 本地 JSONL 文件输出（按日轮转） |
| `http-flusher.ts` | HTTP POST 输出（批量/重试） |
| `multi-flusher.ts` | 多目标扇出（聚合多个 Flusher 并行输出） |

## 架构

```
AgentActivityEntry[]
        │
        ▼
  MultiFlusher.flush()
        │
        ├──→ SlsFlusher   → 阿里云 SLS (批量 20 条 / 2s)
        ├──→ JsonlFlusher → 本地文件 ({clientType}-{YYYY-MM-DD}.jsonl)
        └──→ HttpFlusher  → 外部 HTTP 服务 (批量 20 条 / 5s)
```

## BaseFlusher 接口

<!-- TODO: 列出 BaseFlusher 的抽象方法签名 -->
<!-- TODO: 描述 send() / sendBatch() / flush() / shutdown() 的语义 -->

## SlsFlusher

<!-- TODO: 描述批量发送策略（batchMaxSize / flushIntervalMs） -->
<!-- TODO: 描述健康检查机制 -->
<!-- TODO: 描述失败重试策略 -->
<!-- TODO: 描述双写模式（用户 SLS + 内置 SLS） -->

## JsonlFlusher

<!-- TODO: 描述文件命名规则和按日轮转逻辑 -->
<!-- TODO: 描述 maxFileSizeMb 的处理 -->
<!-- TODO: 描述文件清理策略（log-retention-service 协作） -->

## HttpFlusher

<!-- TODO: 描述 HTTP POST payload 格式 -->
<!-- TODO: 描述 requestTimeoutMs 和重试策略 -->
<!-- TODO: 描述自定义 headers 配置 -->

## 添加新输出通道

<!-- TODO: 描述继承 BaseFlusher 的步骤 -->
<!-- TODO: 描述在 orchestrator.ts buildFlusher() 中注册的方式 -->
