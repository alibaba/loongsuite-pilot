## Why

qoder/qoder-cli 的 trace 数据存在两层叠加的质量问题：

**问题 1（pilot 侧）：三个 Input 无互斥，产出重复/割裂 trace。**

同一次 qoder-cli 对话产出 2 个 trace：一个有消息内容但缺 token（来自 `QoderCliInput` hook 数据），一个有 token 但结构畸形（来自 `QoderCliSessionInput` session 数据）。qoder IDE 同理。根因：hook 事件按 `turn:<turnId>` 分组，session/sqlite 事件无 turn.id 按 `session:<sessionId>` 分组——不同分组键进入不同 TurnBuffer，各自独立转换为独立 trace。

**问题 2（hook 侧）：事件字段不符合转换器规范。**

- §3: thinking + text 被拆到不同 step.id（hook-processor 按 response 计数递增 step）
- §4: user-input 事件有 step.id + model="unknown"，不被转换器识别为 user-hook → 产生幽灵 span
- §5: llm.request/response 时间戳相同 → LLM span 0ms
- §6: hook 事件不携带 token → LLM/AGENT span 的 token 为 0

**数据验证**：本地真实数据确认 hook JSONL 和 session segments 的 `response_id ↔ request_id` 是可靠的 join key（CLI），SQLite 的 `session_id + timestamp(≤1s)` 是可行的近似 join key（IDE）。两个数据源互补：hook 有内容但缺 token，session/SQLite 有 token 但缺内容。

## What Changes

### Phase 1: hook-processor.mjs 修复（独立，可先行上线）

- 修复 step.id 分配逻辑：按 `gen_ai.response.id` 变化检测新 LLM 调用边界
- 修复 user-hook 事件格式：user 类型事件不赋 step.id、不赋 model

### Phase 2: 新建 QoderTraceInput（多源合并）

新建 `QoderTraceInput` 类，读取 hook JSONL + session segments + SQLite，合并后输出完整事件流：
- CLI 路径：按 `response.id ↔ request_id` 精确匹配，注入 token + 真实时间戳
- IDE 路径：按 `session_id + timestamp(≤1s)` 两级匹配，注入 token + response_id
- 生成 `trace_id`（per turn）
- Token 注入规则：同一 response.id 的多条 response 只第一条写 token，其余置 0

### Phase 3: Orchestrator 集成

- QoderTraceInput 启用时，互斥禁用 QoderCliInput、QoderCliSessionInput、QoderSqliteInput
- QoderTraceInput 成为唯一数据源，输出同时服务 event 日志（SLS/JSONL）和 trace（ARMS）

## Capabilities

### New Capabilities
- 多源合并 TraceInput：从多个数据源（hook + session segments + SQLite）合并产出完整事件流

### Modified Capabilities
- hook-processor step.id 分配：从"按 response 计数"改为"按 LLM 调用边界"
- hook-processor user-hook 格式：user 类型事件符合转换器 user-hook 识别条件

## Impact

- Affected baseline modules: `hooks`（hook processor 逻辑变更）、`inputs`（新建 QoderTraceInput + 互斥守卫）、`orchestrator`（注册 + 互斥）
- Affected code areas:
  - `assets/hooks/hook-processor.mjs` — step.id 赋值逻辑
  - `assets/hooks/agent-event-normalizer.mjs` — user 类型 model 处理
  - `src/inputs/qoder-trace/` — 新建目录，4 个文件
  - `src/core/orchestrator.ts` — 互斥守卫注册
- 下游影响：
  - event 日志数量减少（消除纯 token 事件），每条 event 信息密度更高
  - trace 质量大幅提升：token+消息统一、无重复 trace、正确 step 结构
  - SLS ↔ ARMS 可通过 trace_id 互相跳转

## Baseline Documentation Updates

- 无需修改基准文档。本变更遵循 qoder-work-trace 的已有模式（多源合并 + 互斥），不引入新的架构概念。
- 实施完成后将沉淀 TraceInput 实现规范文档（作为后续 change）。
