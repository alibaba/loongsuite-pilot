## Context

各 agent input（cursor-hook、qoder-cli、qoder-work）上报到 SLS 的数据在 `AgentActivityEntry` 顶层字段上已统一，但 `gen_ai.output.messages` 和 `gen_ai.input.messages_delta` 两个嵌套 JSON 字段的内部结构与 `docs/ai_event_schema.md` 规范不一致。

**当前各 input 的格式差异：**

| Input | `gen_ai.input.messages_delta` | `gen_ai.output.messages` |
|---|---|---|
| claude-code（规范） | `[{role, parts:[{type,content}]}]` | `[{role, parts:[...], finishReason}]` |
| cursor-hook | `[{role, content}]` (扁平) | `[{type, content}]` (无 role/parts) |
| qoder-cli | `[{role, content}]` (扁平) | `[{type, content}]` (无 role/parts) |
| qoder-work (hook) | `[{role, content}]` (扁平，走 canonicalHookEntry 直通) | `[{type, content}]` (无 role/parts，走 canonicalHookEntry 直通) |
| qoder-work-log / qoder-work-sqlite / qoder / qoder-sqlite | 不产生或仅读 token | 不产生 |

## Goals / Non-Goals

**Goals:**

- 所有 agent 的 `gen_ai.output.messages` 统一为 `[{role:"assistant", parts:[...], finish_reason:...}]`
- 所有 agent 的 `gen_ai.input.messages_delta` 和 `gen_ai.input.messages` 统一为 `[{role, parts:[{type:"text", content}]}]`
- 规范化逻辑幂等：已规范数据经过规范化函数后不变
- 同时在源头（各 input）和中心化层（entry-builder）双重保障格式正确

**Non-Goals:**

- 不修改 `gen_ai.tool.call.arguments` 和 `gen_ai.tool.call.result` 格式（经确认这两个字段各 agent 格式已一致，均为 raw JSON pass-through）
- 不处理历史 SLS 数据的回填
- 不修改不产生消息字段的 input（qoder-work-log、qoder-work-sqlite、qoder、qoder-sqlite）

## Decisions

### Decision 1: 双层保障策略（hook 层源头修复 + 中心化规范化）

**选择**：在 hook 层（`assets/hooks/agent-event-normalizer.mjs`）的消息构建函数中直接生成规范格式，同时在 `buildAgentActivityEntry` 中增加中心化规范化调用作为安全网。pilot 升级时 hook 同步部署，不存在版本不一致问题。

**替代方案**：

- 在 input 层（`cursor-hook-input.ts`、`qoder-cli-input.ts`）做源头修复：input 层是 hook 数据的二次处理，在此修复属于亡羊补牢，不如在 hook 层一次性产出正确格式
- 仅中心化规范化：运行时有额外转换开销，且源头代码仍然"看起来错误"

**理由**：hook 层是数据的最早产出点，在此标准化确保数据从诞生即规范。input 层无需重复修复，只需透传 hook 已规范化的数据。entry-builder 的中心化规范化作为幂等安全网，防止未来新增 hook 或外部数据源引入不一致。

### Decision 2: 新建 `src/normalization/normalize-messages.ts` 模块

**选择**：将规范化函数放在独立文件中，而非直接嵌入 `entry-builder.ts`。

**理由**：

- `entry-builder.ts` 已有 470+ 行，职责较重
- 独立模块便于独立测试
- 符合 normalization 模块的现有代码布局模式

### Decision 3: finish_reason 使用 snake_case

**选择**：统一使用 `finish_reason`（snake_case），与 OTel 官方 JSON Schema（`docs/gen-ai-output-messages.json`）保持一致。

**背景**：claude-code 线上数据使用 `finishReason`（camelCase），但官方 schema `OutputMessage` 定义的 required 字段为 `finish_reason`（snake_case）。以 schema 为权威标准，claude-code 的 camelCase 属于不规范实现。规范化函数需同时处理两种命名：将 `finishReason` 重命名为 `finish_reason`，保留已正确的 `finish_reason`。

### Decision 4: 规范化函数在 `buildAgentActivityEntry` 中的调用位置

**选择**：在 `removeLegacyAliases(entry)` 调用之前执行规范化。

**理由**：确保规范化作用于已完成 alias 合并但尚未清理的 entry，此时所有字段都已就位。

## Risks / Trade-offs

- **过渡期数据格式不一致** → 部署后新数据格式统一，但历史数据保持旧格式。下游查询需在过渡期兼容两种格式（通过 JSON 解析时检查是否有 `parts` 字段）。
- **规范化函数的运行时开销** → 幂等设计，已规范数据仅做类型检查即返回，性能影响可忽略。每条 entry 的嵌套字段通常只有 1-3 个 message 对象。
- **claude-code 历史数据 camelCase 不兼容** → claude-code 已有数据使用 `finishReason`，规范化后新数据将使用 `finish_reason`。下游查询需兼容两种命名（过渡期）。规范化函数会将 `finishReason` 转为 `finish_reason`，确保新数据统一。
