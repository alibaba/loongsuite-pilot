# Research: 平台基础设施（Platform Base）

**Feature**: `001-platform-base`
**Date**: 2026-04-27

## 1. 归一化层测试策略

**Decision**: 使用纯函数级别的单元测试，无需 mock 依赖

**Rationale**: `entry-builder.ts` 中的三个核心函数（`buildAgentActivityEntry`、`serialiseLogEntry`、`redactCodeGenerationFields`）均为纯函数或近纯函数（仅依赖 `uuid` 和 `Date.now()`），可直接用 Vitest 的 `vi.mock` 控制 UUID 生成和时间戳。

**Alternatives considered**:
- 集成测试（从输入源到序列化输出）：已有契约测试覆盖 `AgentActivityEntry` schema，无需重复
- Snapshot 测试：序列化输出为动态键值对，snapshot 测试维护成本高

**测试要点**:
- `buildAgentActivityEntry`: UUID 唯一性、时间戳自动填充、所有字段透传
- `serialiseLogEntry`: Git 嵌套展平、extra 字段合并、敏感键过滤、秒→毫秒转换、null/undefined 跳过
- `redactCodeGenerationFields`: 三个字段移除、原始对象不变（不可变性）
- `buildFromCodeGenerationEvent`: CodeGenerationEvent → AgentActivityEntry 字段映射

## 2. Flusher 层测试策略

**Decision**: 对每个 Flusher 使用 mock 依赖的单元测试 + 对 MultiFlusher 的故障隔离集成测试

**Rationale**: Flusher 涉及文件 I/O（JSONL）、网络请求（SLS/HTTP）等外部依赖，必须通过 mock 隔离。MultiFlusher 的故障隔离是核心行为，需要集成测试验证。

**Alternatives considered**:
- 真实 SLS/HTTP 端点测试：违反宪法"测试必须是确定性的"，且依赖外部服务
- 仅测试 MultiFlusher：无法验证各 Flusher 的序列化和批量逻辑

**各 Flusher 测试策略**:

| Flusher | Mock 方式 | 核心测试场景 |
|---------|----------|-------------|
| JsonlFlusher | `vi.mock` fs-utils 的 `appendLine`/`ensureDir` | 文件路径生成（日期轮转 vs all）、序列化格式、sendRaw 主题路由 |
| SlsFlusher | `vi.mock` `@alicloud/log` 的 `postLogStoreLogs` | 多 endpoint 路由、脱敏 vs 非脱敏、批量阈值触发 flush、失败持久化到本地文件 |
| HttpFlusher | `vi.mock` `axios.post` | 批量缓冲、阈值触发 flush、失败重新入队（unshift）、超时配置、shutdown 时 flush |
| MultiFlusher | 创建 mock BaseFlusher 子类 | 并行分发（Promise.allSettled）、单通道失败不影响其他、sendRaw 转发 |

## 3. Core 编排层测试策略

**Decision**: 使用 mock 注入的单元测试 + 轻量集成测试验证启动/关闭流程

**Rationale**: 编排层依赖所有子系统（StateStore、InputManager、AgentDiscoveryService、各种 Flusher），需要 mock 所有下游依赖来隔离测试。但启动/关闭顺序是核心行为，需要集成验证。

**各组件测试策略**:

| 组件 | 核心测试场景 |
|------|-------------|
| ConfigLoader | env > file > default 优先级、缺失配置文件降级、SLS/HTTP/JSONL 配置合并、env 变量覆盖 |
| AgentControlManager | load/save 持久化、resolveEnabled 三级模式（on/off/auto）、文件缺失降级 |
| InputManager | registerInput 去重、startInput/stopInput 生命周期、事件订阅和 dispatch、userId 注入 |
| AgentDiscoveryService | 状态机转换（idle→starting→running→stopping→idle）、enabled+available 组合、setupWatcher 降级到 polling |
| Orchestrator | 启动顺序验证、停止顺序验证、幂等性（重复 start/stop）、无 flusher 时 JSONL 兜底 |

**Alternatives considered**:
- E2E 测试（真实 fs.watch + 真实文件系统）：不稳定且平台相关，违反确定性原则
- 仅测试 Orchestrator：无法验证各子组件的独立行为

## 4. SLS SDK Mock 策略

**Decision**: 使用 `vi.mock('@alicloud/log')` 创建 mock constructor，返回带有 `postLogStoreLogs` spy 的对象

**Rationale**: `@alicloud/log` 是一个 default export 构造函数，需要 mock constructor 模式。

**实现方式**:
```typescript
vi.mock('@alicloud/log', () => ({
  default: vi.fn().mockImplementation(() => ({
    postLogStoreLogs: vi.fn().mockResolvedValue(undefined),
  })),
}));
```

## 5. HTTP 客户端 Mock 策略

**Decision**: 使用 `vi.mock('axios')` mock `axios.post`

**Rationale**: HttpFlusher 仅使用 `axios.post`，mock 简单直接。

**实现方式**:
```typescript
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));
```

## 6. ConfigLoader 环境变量测试

**Decision**: 使用 `vi.stubEnv` / `vi.unstubAllEnvs` 在每个测试用例中设置和清理环境变量

**Rationale**: Vitest 内置 `vi.stubEnv` 支持在测试间隔离环境变量，比直接操作 `process.env` 更安全。

## 7. AgentDiscoveryService fs.watch 测试

**Decision**: Mock `fs.watch` 返回一个 EventEmitter stub，测试 watcher 创建和降级逻辑

**Rationale**: `fs.watch` 的行为在不同平台上不一致，且测试中无法可靠触发文件系统事件。Mock 后可精确控制 watcher 行为和错误场景。

**降级场景**: 当 `fs.watch` 抛出异常或 watcher emit 'error' 时，自动切换到 setInterval 轮询。
