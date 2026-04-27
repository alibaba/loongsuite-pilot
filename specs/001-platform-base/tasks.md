# Tasks: 平台基础设施（Platform Base）

**Input**: Design documents from `specs/001-platform-base/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Context**: 输入源框架（US1）和持久化层（US2）已有完整的测试覆盖（174 个测试，85%+ 覆盖率）。本任务清单聚焦于补充归一化层（US3）、数据输出（US4）和核心编排（US5/US6）的测试，以达到宪法要求的 80% 全局覆盖率。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US3, US4, US5, US6)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: 创建新增测试模块的目录结构和共享测试工具

- [X] T001 创建测试目录结构 `tests/unit/normalization/`, `tests/unit/flushers/`, `tests/unit/core/`
- [X] T002 [P] 创建 Flusher 测试辅助模块 `tests/helpers/mock-flusher.ts`（提供 BaseFlusher 的 mock 子类，跟踪 send/sendBatch/flush/shutdown 调用次数和参数）

---

## Phase 2: Foundational (US1 + US2 — 已完成)

**Purpose**: 输入源框架和持久化层测试

> ✅ **已完成** — 174 个测试，覆盖率 85%+。包括 BaseInput、BaseHookInput、BaseSessionInput、BaseIdeInput、StateStore、SnapshotStore 的单元测试和集成测试。

**Checkpoint**: 基础框架测试已就位，可以开始上层模块测试。

---

## Phase 3: US3 — 异构数据归一化与序列化（Priority: P1）

**Goal**: 验证 `entry-builder.ts` 中的归一化、序列化和脱敏三大核心函数的正确性。

**Independent Test**: 运行 `npx vitest run tests/unit/normalization/` 全部通过。

- [X] T003 [P] [US3] 测试 `buildAgentActivityEntry` 工厂方法 `tests/unit/normalization/build-entry.test.ts` — 验证 UUID 唯一性（mock uuid）、时间戳自动填充（mock Date.now）、显式时间戳透传、所有必需字段存在、可选字段（content/git/extra）正确携带
- [X] T004 [P] [US3] 测试 `buildFromCodeGenerationEvent` 转换方法 `tests/unit/normalization/build-from-event.test.ts` — 验证 CodeGenerationEvent 字段正确映射为 AgentActivityEntry（agentType/actionType/filePath/content/diff→inlineDiffMessage/rawData→extra）
- [X] T005 [P] [US3] 测试 `serialiseLogEntry` 序列化方法 `tests/unit/normalization/serialise.test.ts` — 验证基础字段序列化、Git 嵌套展平为 repoId/branchName/commitHash、extra 字段合并到顶层（值转字符串）、敏感键过滤（filePath/content/inlineDiffMessage/recorduuid/distinctid 不出现在 extra 展开中）、null/undefined 值跳过、秒级时间戳自动 ×1000 转毫秒、复杂对象值 JSON.stringify、布尔/数字值 String() 转换
- [X] T006 [P] [US3] 测试 `redactCodeGenerationFields` 脱敏方法 `tests/unit/normalization/redact.test.ts` — 验证移除 filePath/content/inlineDiffMessage 三个字段、原始对象未被修改（返回新副本）、缺少这些字段时输出不变
- [X] T007 [US3] 测试 `normalizeTimestampToMillis` 边界 `tests/unit/normalization/serialise.test.ts`（追加）— 验证 ts=0 / ts<0 / ts=恰好 1e12 的边界行为

**Checkpoint**: 归一化层测试全部通过，4 个公开函数 100% 覆盖。

---

## Phase 4: US4 — 可靠的多目标数据输出（Priority: P1）

**Goal**: 验证 JSONL/SLS/HTTP 三种输出通道和 MultiFlusher 扇出隔离的正确性。

**Independent Test**: 运行 `npx vitest run tests/unit/flushers/` 全部通过。

### JsonlFlusher

- [X] T008 [P] [US4] 测试 JsonlFlusher 基本写入 `tests/unit/flushers/jsonl-flusher.test.ts` — mock `appendLine`/`ensureDir`，验证 send() 调用 serialiseLogEntry + appendLine，输出行为合法 JSON 包含 uuid/logTime/agentType/data
- [X] T009 [P] [US4] 测试 JsonlFlusher 日期轮转文件命名 `tests/unit/flushers/jsonl-flusher.test.ts`（追加）— rotateDaily=true 时文件名为 `{agentType}-{YYYY-MM-DD}.jsonl`，rotateDaily=false 时为 `{agentType}-all.jsonl`
- [X] T010 [P] [US4] 测试 JsonlFlusher sendRaw `tests/unit/flushers/jsonl-flusher.test.ts`（追加）— 验证 sendRaw 写入 `{topic}-{YYYY-MM-DD}.jsonl`，内容包含 topic 和 payload
- [X] T011 [P] [US4] 测试 JsonlFlusher sendBatch `tests/unit/flushers/jsonl-flusher.test.ts`（追加）— 验证 sendBatch 逐条调用 send，appendLine 调用次数等于 entries 长度

### SlsFlusher

- [X] T012 [P] [US4] 测试 SlsFlusher 多 endpoint 路由 `tests/unit/flushers/sls-flusher.test.ts` — mock `@alicloud/log`，验证 send() 对每个 endpoint 调用 enqueue，flush 时按 (project,logstore) 分组调用 postLogStoreLogs
- [X] T013 [P] [US4] 测试 SlsFlusher 脱敏逻辑 `tests/unit/flushers/sls-flusher.test.ts`（追加）— endpoint.redact=true 时调用 redactCodeGenerationFields，redact=false 时使用原始序列化
- [X] T014 [US4] 测试 SlsFlusher 批量阈值触发 `tests/unit/flushers/sls-flusher.test.ts`（追加）— 入队数达到 batchMaxSize 时自动触发 flush
- [X] T015 [US4] 测试 SlsFlusher 失败持久化 `tests/unit/flushers/sls-flusher.test.ts`（追加）— postLogStoreLogs 抛出异常时，logGroup 被 persistFailedLogs 写入 `sls-failed-logs/{kind}.jsonl`
- [X] T016 [US4] 测试 SlsFlusher shutdown `tests/unit/flushers/sls-flusher.test.ts`（追加）— shutdown 停止定时器并执行最后一次 flush
- [X] T017 [P] [US4] 测试 SlsFlusher sendRaw `tests/unit/flushers/sls-flusher.test.ts`（追加）— 仅转发到 kind 为 'mcp' 或 'trace' 的 endpoint

### HttpFlusher

- [X] T018 [P] [US4] 测试 HttpFlusher 批量缓冲与 flush `tests/unit/flushers/http-flusher.test.ts` — mock `axios.post`，验证 send() 推入 buffer，达到 batchMaxSize 自动 flush，flush 发送 `{ entries: batch }` 到配置 URL
- [X] T019 [US4] 测试 HttpFlusher 失败重新入队 `tests/unit/flushers/http-flusher.test.ts`（追加）— axios.post 抛出异常时，batch 通过 unshift 放回 buffer 头部
- [X] T020 [US4] 测试 HttpFlusher shutdown `tests/unit/flushers/http-flusher.test.ts`（追加）— shutdown 停止定时器并执行最后一次 flush（buffer 中有剩余数据时）
- [X] T021 [P] [US4] 测试 HttpFlusher 请求配置 `tests/unit/flushers/http-flusher.test.ts`（追加）— 验证自定义 headers 和 timeout 传递到 axios.post

### MultiFlusher

- [X] T022 [P] [US4] 测试 MultiFlusher 并行分发与故障隔离 `tests/unit/flushers/multi-flusher.test.ts` — 使用 mock-flusher，验证 sendBatch 并行调用所有子 flusher（Promise.allSettled），一个失败其他正常完成
- [X] T023 [US4] 测试 MultiFlusher sendRaw 转发 `tests/unit/flushers/multi-flusher.test.ts`（追加）— sendRaw 并行转发到所有子 flusher
- [X] T024 [US4] 测试 MultiFlusher shutdown `tests/unit/flushers/multi-flusher.test.ts`（追加）— shutdown 并行调用所有子 flusher 的 shutdown

**Checkpoint**: 数据输出层测试全部通过，JSONL/SLS/HTTP/MultiFlusher 核心行为覆盖。

---

## Phase 5: US5 — 一键启动与优雅关闭（Priority: P1）

**Goal**: 验证 ConfigLoader 配置合并、InputManager 事件分发和 Orchestrator 启动/关闭流程。

**Independent Test**: 运行 `npx vitest run tests/unit/core/` 全部通过。

### ConfigLoader

- [X] T025 [P] [US5] 测试 ConfigLoader 三层优先级 `tests/unit/core/config-loader.test.ts` — 使用 `vi.stubEnv`，验证 env > file > default：(1) env 变量覆盖配置文件同名字段 (2) 配置文件覆盖默认值 (3) 两者缺失时使用默认值
- [X] T026 [P] [US5] 测试 ConfigLoader 缺失配置文件降级 `tests/unit/core/config-loader.test.ts`（追加）— mock `readJsonFile` 返回 null，验证使用全默认配置启动
- [X] T027 [US5] 测试 ConfigLoader SLS/HTTP/JSONL 配置合并 `tests/unit/core/config-loader.test.ts`（追加）— 验证 SLS endpoint 从 file+env 合并（去重），HTTP/JSONL enabled 状态正确

### AgentControlManager

- [X] T028 [P] [US5] 测试 AgentControlManager 三级模式 `tests/unit/core/agent-control-manager.test.ts` — 验证 resolveEnabled: mode='on' 返回 true，mode='off' 返回 false，mode='auto' 返回 defaultWhenAuto
- [X] T029 [US5] 测试 AgentControlManager load/save 持久化 `tests/unit/core/agent-control-manager.test.ts`（追加）— 使用临时文件验证 load/setMode/save/reload 周期

### InputManager

- [X] T030 [P] [US5] 测试 InputManager 注册和事件分发 `tests/unit/core/input-manager.test.ts` — 使用 mock BaseInput 和 mock BaseFlusher，验证 registerInput 订阅 'entries' 事件，handleEntries 调用 flusher.sendBatch
- [X] T031 [US5] 测试 InputManager userId 注入 `tests/unit/core/input-manager.test.ts`（追加）— setUserId 后，handleEntries 为缺少 userId 的 entry 自动填充
- [X] T032 [US5] 测试 InputManager registerInput 去重 `tests/unit/core/input-manager.test.ts`（追加）— 同一 id 重复注册时，第二次被忽略并记录警告
- [X] T033 [US5] 测试 InputManager startInput/stopInput `tests/unit/core/input-manager.test.ts`（追加）— 验证 start/stop 代理到对应 input 的 start/stop 方法

**Checkpoint**: 配置加载、准入控制和输入管理测试全部通过。

---

## Phase 6: US6 — 自动发现与准入控制（Priority: P2）

**Goal**: 验证 AgentDiscoveryService 的状态机转换、fs.watch 降级和 Orchestrator 的端到端启停流程。

**Independent Test**: 运行 `npx vitest run tests/unit/core/` 全部通过。

### AgentDiscoveryService

- [X] T034 [P] [US6] 测试 AgentDiscoveryService 状态机 `tests/unit/core/agent-discovery-service.test.ts` — mock isAvailable/enabled/start/stop 回调，验证 idle→starting→running→stopping→idle 转换
- [X] T035 [US6] 测试 AgentDiscoveryService enabled+available 组合 `tests/unit/core/agent-discovery-service.test.ts`（追加）— enabled=false 时不启动（即使 available=true），enabled=true+available=false 时不启动，enabled=true+available=true 时启动
- [X] T036 [US6] 测试 AgentDiscoveryService fs.watch 降级 `tests/unit/core/agent-discovery-service.test.ts`（追加）— mock `fs.watch` 抛出异常时自动切换到 setInterval 轮询
- [X] T037 [US6] 测试 AgentDiscoveryService stop `tests/unit/core/agent-discovery-service.test.ts`（追加）— stop 关闭所有 watcher 和定时器，运行中的 entry 被停止

### Orchestrator 集成

- [X] T038 [US6] 测试 Orchestrator 启动顺序 `tests/unit/core/orchestrator.test.ts` — mock 所有子系统，验证 start() 调用顺序：ensureDir → stateStore.load → agentControl.load → buildFlusher → inputManager.setFlusher → registerAllInputs → discovery.start
- [X] T039 [US6] 测试 Orchestrator 停止顺序 `tests/unit/core/orchestrator.test.ts`（追加）— 验证 stop() 调用顺序：discovery.stop → inputManager.stopAll → flusher.shutdown → stateStore.save
- [X] T040 [US6] 测试 Orchestrator 幂等性 `tests/unit/core/orchestrator.test.ts`（追加）— 重复 start() 在 isRunning=true 时直接返回，重复 stop() 在 isRunning=false 时直接返回
- [X] T041 [US6] 测试 Orchestrator JSONL 兜底 `tests/unit/core/orchestrator.test.ts`（追加）— 所有 flusher 配置 enabled=false 时，buildFlusher 返回 JsonlFlusher 兜底实例

**Checkpoint**: 自动发现和编排器测试全部通过。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 全局覆盖率验证和质量检查

- [X] T042 运行 `npm run test:coverage` 验证所有模块覆盖率达到 80% 阈值（statements/branches/functions/lines），更新 `vitest.config.ts` 的 coverage.include 以涵盖 `src/normalization/**`, `src/flushers/**`, `src/core/**`
- [X] T043 运行 `npm run typecheck` 验证零类型错误
- [X] T044 按 `quickstart.md` 验证快速上手流程可执行

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 无依赖，立即开始
- **Phase 2 (Foundational)**: ✅ 已完成
- **Phase 3 (US3 Normalization)**: 依赖 Phase 1 完成
- **Phase 4 (US4 Flushers)**: 依赖 Phase 1 完成（与 Phase 3 可并行）
- **Phase 5 (US5 Core 启停)**: 依赖 Phase 1 完成（与 Phase 3/4 可并行）
- **Phase 6 (US6 Core 发现)**: 依赖 Phase 5 部分完成（InputManager 测试）
- **Phase 7 (Polish)**: 依赖所有 Phase 完成

### User Story Dependencies

- **US3 (Normalization)**: 独立，不依赖其他 US
- **US4 (Flushers)**: 独立，不依赖其他 US（内部使用 serialiseLogEntry 但通过 mock 隔离）
- **US5 (Core 启停)**: 独立，不依赖其他 US
- **US6 (Core 发现)**: 依赖 US5 的 InputManager 测试

### Parallel Opportunities

```
Phase 1 完成后：

  ┌── Phase 3 (US3: Normalization) ──┐
  │                                   │
  ├── Phase 4 (US4: Flushers) ───────┤── Phase 7 (Polish)
  │                                   │
  └── Phase 5 (US5: Core 启停) ──────┘
                │
                └── Phase 6 (US6: Core 发现)
```

---

## Implementation Strategy

### MVP First (US3 Only)

1. Complete Phase 1: Setup
2. Complete Phase 3: US3 Normalization 测试
3. **VALIDATE**: `npx vitest run tests/unit/normalization/` 全部通过

### Incremental Delivery

1. Phase 1 → Phase 3 (US3) → 归一化层覆盖完成
2. Phase 4 (US4) → 输出层覆盖完成
3. Phase 5 (US5) + Phase 6 (US6) → 编排层覆盖完成
4. Phase 7 → 全局 80% 覆盖率达标

---

## Summary

| Phase | User Story | 任务数 | 状态 |
|-------|-----------|--------|------|
| Phase 1 | Setup | 2 | ✅ 已完成 |
| Phase 2 | US1+US2 (Inputs+Checkpoints) | — | ✅ 已完成 |
| Phase 3 | US3 (Normalization) | 5 | ✅ 已完成 |
| Phase 4 | US4 (Flushers) | 17 | ✅ 已完成 |
| Phase 5 | US5 (Core 启停) | 9 | ✅ 已完成 |
| Phase 6 | US6 (Core 发现) | 8 | ✅ 已完成 |
| Phase 7 | Polish | 3 | ✅ 已完成 |
| **Total** | | **44** | ✅ |
