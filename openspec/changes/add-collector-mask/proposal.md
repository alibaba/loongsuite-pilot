## Why

最近一周采集到的 AI Coding 数据显示，`gen_ai.input.messages`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` 等大字段中会出现云 AccessKey ID、API Key、私钥块、带密码的数据库连接串。

当前已有 `captureMessageContent=false` 和 SLS endpoint `redact=true` 两类控制，但前者是整字段删除，后者只作用于单个 SLS endpoint。缺少一个 collector 统一上报前的字段内打码能力，导致 log 和 trace 出口无法在保留上下文的同时统一去除明确 secret。

本变更在 collector 分发给 flusher 前新增 `mask` 处理，使 JSONL / SLS / HTTP log 和 OTLP trace 都基于同一份已脱敏 `AgentActivityEntry`。

## What Changes

### Phase 1: 顶层 mask 配置

- 新增 `mask` 配置，放在 `~/.loongsuite-pilot/config.json` 最外层
- 支持 `mode`: `all`、`custom`、`none`
- 支持 `types`: `custom` 模式下选择启用的脱敏类别
- `agents.<agent>.captureMessageContent` 保持原职责，只控制是否保留消息内容字段

### Phase 2: 新建 collector mask 模块

- 新建 `src/mask/`
- 新增规则文件 `src/mask/sensitive-rules.json`
- 规则集中维护，代码侧负责加载、校验、预编译和执行
- 本次变更只支持高置信类型：
  - `cloudAccessKey`
  - `apiKey`
  - `privateKey`
  - `databaseUrl`

### Phase 3: Collector 分发前接入

- 在 `applyAgentContentPolicy()` 之后执行 mask
- 在 `dispatchEntries()` 之前完成脱敏
- 不修改 hook 本地 history 文件
- 保持现有 SLS endpoint `redact` 行为不变

## Capabilities

### New Capabilities

- `collector-mask`: collector 侧字段内 secret 打码，在 log / trace 上报前统一替换高置信敏感内容。

### Modified Capabilities

- 无。该能力补充已完成的 `add-sensitive-data-controls`，不修改其 `captureMessageContent` 语义。

## Impact

- Affected baseline modules: `core`（配置加载、InputManager 接入）、`types`（新增 mask 配置类型）、`normalization`（与 content policy/redact 关系）、`flushers`（收到已脱敏数据）、`ai_event_schema`（entry 字段与 trace attribute 来源）。
- Affected code areas:
  - `src/types/index.ts` — 新增 `MaskConfig` / `MaskMode` / `MaskType`
  - `src/core/config-loader.ts` — 解析顶层 `mask`
  - `src/core/orchestrator.ts` — 传递 `config.mask`
  - `src/core/input-manager.ts` — 在分发前调用 mask
  - `src/mask/` — 新增脱敏模块
  - `src/mask/sensitive-rules.json` — 新增本次变更规则
- 下游影响：
  - log 和 trace 中的明确 secret 被替换为 `[{TYPE}_MASKED]`
  - 内容字段仍保留上下文，不再整字段删除
  - hook 本地 history 文件不受影响，仍可能包含原始数据

## Baseline Documentation Updates

- 需要 review 并更新 baseline docs。
- 重点补充：
  - `mask.mode/types` 配置说明
  - collector 侧 mask 发生在 flusher 分发前
  - 本次变更支持与不支持的敏感类别
  - `captureMessageContent`、`mask`、SLS endpoint `redact` 三者关系
