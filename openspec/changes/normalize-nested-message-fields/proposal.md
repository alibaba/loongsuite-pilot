## Why

cursor、qoder-cli、qoder-work 三类 agent 上报到 SLS 的数据在 `AgentActivityEntry` 顶层字段上已统一，但 3 个嵌套 JSON 字段（`gen_ai.output.messages`、`gen_ai.input.messages_delta`、`gen_ai.input.messages`）的内部结构不符合 `docs/ai_event_schema.md` 定义的规范格式。这导致下游消费方（dashboard、分析查询）需要为每种 agent 编写不同的解析逻辑，增加了维护成本和出错风险。

## What Changes

- **`gen_ai.output.messages` 格式统一**：cursor-hook 和 qoder-cli 当前输出 bare parts 格式 `[{type, content}]`，缺少 `role` 和 `parts` 包装；qoder-work 使用了 `{role, parts}` 但 finish reason 字段名不一致。统一为规范格式 `[{role:"assistant", parts:[...], finishReason:...}]`。
- **`gen_ai.input.messages_delta` 格式统一**：cursor-hook 和 qoder-cli 当前输出扁平 content 格式 `[{role, content:string}]`，缺少 `parts` 数组包装。统一为规范格式 `[{role, parts:[{type:"text", content}]}]`。
- **新增中心化消息格式规范化函数**：在 normalization 层新增幂等的格式规范化函数，作为 `buildAgentActivityEntry` 的组成部分，确保所有经过 entry-builder 的数据都符合规范格式，无论上游 input 如何构造。
- **各 input 源头同步修复**：同时修复 cursor-hook、qoder-cli、qoder-work 等 input 的源头构造逻辑，使其直接生成规范格式，避免依赖中心化规范化做运行时修正。

## Capabilities

### New Capabilities
- `message-format-normalization`: 中心化的消息嵌套字段格式规范化能力，提供幂等函数将各种非规范格式转换为 `docs/ai_event_schema.md` 定义的标准结构

### Modified Capabilities

（无已有 spec 需修改）

## Impact

- **Affected Baseline Modules**:
  - `normalization` (`docs/modules/normalization.md`) — 新增规范化函数并集成到 `buildAgentActivityEntry` 流程
  - `inputs` (`docs/modules/inputs.md`) — 修改 cursor-hook、qoder-cli、qoder-work 等 input 的 `transformRecord` / 消息构建函数
- **Affected Code**:
  - `src/normalization/entry-builder.ts` — 集成规范化调用
  - `src/normalization/normalize-messages.ts` — 新文件
  - `src/inputs/cursor-hook/cursor-hook-input.ts` — `buildOutputMessages()`, `buildInputMessagesDelta()`
  - `src/inputs/qoder-cli/qoder-cli-input.ts` — 同上
  - `src/inputs/qoder-work/qoder-work-input.ts` — finishReason 字段名修正
  - 相关 qoder-work-log、qoder-work-sqlite input — 需检查并对齐
- **SLS 数据格式变更**：部署后新数据的嵌套字段格式将与 claude-code 一致；历史数据不受影响，下游查询需兼容过渡期
- **无 breaking change**：顶层字段结构不变，仅嵌套 JSON 内部结构统一
