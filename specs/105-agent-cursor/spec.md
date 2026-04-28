# 功能规格说明：Cursor Hook Agent

**功能分支**: `105-agent-cursor`  
**创建日期**: 2026-04-27  
**状态**: Draft  
**依赖**: `001-platform-base`（统一日志目录、状态持久化约定、归一化字段约定）

## Clarifications

### Session 2026-04-27

- Q: 对于 Cursor hook 原始字段（`text`、`tool_output`、`input_messages`）的日志留存策略是什么？ → A: 完整保留原始内容，不做默认脱敏。
- Q: `cursor-YYYY-MM-DD.jsonl` 的保留策略如何定义？ → A: 保留天数可配置，默认 90 天。

## 用户场景与测试 *(mandatory)*

### 用户故事 1 - 采集 Cursor Hook 事件日志 (Priority: P1)

作为平台运维人员，我需要从 Cursor 的多类 Hook 事件持续采集遥测记录，并写入统一的本地 JSONL 日志，以便后续查询、审计和上报。

**Why this priority**: 没有稳定采集，就无法构建 Cursor 相关的数据分析能力。

**Independent Test**: 向统一 hook 入口输入合法的 Cursor payload，验证当天日志文件新增记录，且包含 `clientType=CursorHook` 与对应 `hookEvent`。

**Acceptance Scenarios**:

1. **Given** Cursor 生效 hook 配置（项目级或用户级）中多个事件共享同一个 hook command，**When** 任意事件触发，**Then** payload 会被追加写入 `cursor-YYYY-MM-DD.jsonl`
2. **Given** 同一天触发多个事件，**When** 处理器执行，**Then** 记录按行追加在同一文件中，不覆盖既有内容
3. **Given** 事件字段不完全相同，**When** 写入记录，**Then** 每条记录仍满足统一顶层结构（`uuid`、`logTime`、`reported`、`clientType`、`hookEvent`、`data`）

---

### 用户故事 2 - 标准字段映射与兼容输出 (Priority: P1)

作为数据分析人员，我需要不同 hook 事件输出可比较的标准字段，以支持跨事件关联会话、模型、工具调用和错误信息。

**Why this priority**: 字段语义不稳定会导致下游统计和检索逻辑复杂化。

**Independent Test**: 构造 `postToolUse`、`postToolUseFailure`、`afterAgentResponse` 三类样例 payload，验证标准字段映射一致，且被消费的源字段被清理。

**Acceptance Scenarios**:

1. **Given** payload 含 `session_id` 或 `conversation_id`，**When** 执行映射，**Then** 输出 `gen_ai.session_id` 并删除被映射源字段
2. **Given** payload 含 `tool_input` 与 `tool_output`/`result_json`，**When** 执行映射，**Then** 输出 `gen_ai.tool_arguments` 与 `gen_ai.tool_results`
3. **Given** payload 无 `output_messages` 但含 `text`，**When** 执行映射，**Then** 输出兼容的 `gen_ai.output_messages` 数组

---

### 用户故事 3 - Fail-Open 运行保障 (Priority: P2)

作为 Cursor 用户，我需要 hook 链路异常时不影响正常交互和工具执行，确保采集问题不会阻断工作流。

**Why this priority**: 遥测是辅助能力，可靠性目标是“尽力采集，不阻塞主流程”。

**Independent Test**: 分别模拟空输入、非法 JSON、处理器崩溃、写文件失败，验证 hook 入口仍成功返回。

**Acceptance Scenarios**:

1. **Given** stdin 为空或只包含空白字符，**When** hook 脚本执行，**Then** 立即成功退出且不写入无效记录
2. **Given** 输入不是合法 JSON，**When** 处理器解析，**Then** 忽略该输入并成功返回
3. **Given** 处理器执行失败或日志目录不可写，**When** hook 执行，**Then** 返回成功并允许 Cursor 流程继续

---

### 用户故事 4 - 事件覆盖与配置一致性 (Priority: P2)

作为平台维护者，我需要规范中的事件范围与 Cursor 实际生效的 hook 配置保持一致（项目级或用户级），避免采集缺口。

**Why this priority**: 配置与规范偏差会造成“以为采了但实际上没采”的灰色故障。

**Independent Test**: 对照规范中的事件清单逐项核对 Cursor 生效配置中的事件键名与命令配置。

**Acceptance Scenarios**:

1. **Given** 规范声明支持 tool、shell、MCP、file、prompt、session、subagent、model text 事件族，**When** 校验 Cursor 生效配置，**Then** 事件键全部存在并指向统一 hook 命令
2. **Given** 新增或移除事件支持范围，**When** 更新实现，**Then** 同步更新 spec 与 hooks 配置

---

### 用户故事 5 - 接入统一上报通路 (Priority: P1)

作为平台运维人员，我需要将 Cursor hook 落盘日志接入 collector 主程序输入源，使其能复用现有上报链路并按配置输出到 SLS/JSONL。

**Why this priority**: 仅有 hooks 侧落盘无法满足统一上报与下游检索，必须进入现有编排管道。

**Independent Test**: 启动 collector 并开启 `listeners.cursor-hook` 后，`cursor-hook` 日志可被读取并通过已启用 flusher 输出。

**Acceptance Scenarios**:

1. **Given** `cursor-YYYY-MM-DD.jsonl` 存在新增记录，**When** `CursorHookInput` 轮询运行，**Then** 记录被转换为统一 `AgentActivityEntry`
2. **Given** orchestrator 已注册 `cursor-hook` 输入源且 listener 已启用，**When** 输入源产出记录，**Then** 记录进入统一 `InputManager -> Flusher` 链路
3. **Given** 已启用 `sls` 和/或 `jsonl` flusher，**When** Cursor 记录被处理，**Then** 数据按现有上报机制写入目标输出

---

### Edge Cases

- `hook_event_name` 缺失、为空或非字符串时，归一化为 `unknown`
- `tool_input`、`tool_output`、`input_messages` 可能是对象或 JSON 字符串，解析失败时保留原始值或跳过该映射字段
- 记录中包含空对象/空数组/`undefined` 时，从输出 `data` 中清理
- 输入存在未参与映射的业务字段时，这些字段在 `data` 中保留
- 同一键同时存在“原始字段”和“标准字段”冲突时，标准字段优先

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统必须提供一个可复用的 Cursor hook 入口脚本，支持被多个事件共享调用
- **FR-002**: 系统必须在处理成功时将记录按 JSONL 逐行追加到 `~/.ai-agent-collector/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl`
- **FR-003**: 系统必须输出统一记录结构：`uuid`、`logTime`、`reported`、`clientType`、`hookEvent`、`data`
- **FR-004**: 系统必须将标准字段映射写入 `data`，至少包含会话标识、模型标识、角色、工具调用、错误信息等核心字段
- **FR-005**: 系统必须保留未被映射消费的原始字段，并移除已消费的源字段
- **FR-006**: 系统必须对非法输入、运行时异常和写入失败保持 fail-open，不阻塞 Cursor 主流程
- **FR-007**: 系统必须支持并配置以下事件：`preToolUse`、`postToolUse`、`postToolUseFailure`、`beforeShellExecution`、`afterShellExecution`、`beforeMCPExecution`、`afterMCPExecution`、`beforeReadFile`、`afterFileEdit`、`beforeSubmitPrompt`、`preCompact`、`stop`、`sessionStart`、`sessionEnd`、`subagentStart`、`subagentStop`、`afterAgentResponse`、`afterAgentThought`、`beforeTabFileRead`、`afterTabFileEdit`
- **FR-008**: 系统必须在支持事件成功处理后返回空 JSON 对象字符串（`{}`），不返回权限控制决策字段
- **FR-009**: raw payload 到标准字段的详细映射、字段清理规则和冲突优先级必须维护在 `specs/105-agent-cursor/research.md`，并与实现保持一致
- **FR-010**: 系统必须默认保留原始正文类字段内容（如 `text`、`tool_output`、`input_messages`），不执行自动脱敏或裁剪
- **FR-011**: 系统必须支持日志保留天数配置，默认保留 90 天，并在设计阶段明确清理执行策略
- **FR-012**: 系统必须提供 `CursorHookInput` 并在 orchestrator 中注册 `cursor-hook` 监听项，用于消费 `logs/cursor-hook/history/` 下的按日日志文件
- **FR-013**: 系统必须将 `CursorHookInput` 产出的记录接入现有统一上报链路，并复用已启用的 flusher（如 SLS、JSONL）

### Key Entities *(include if feature involves data)*

- **CursorHookRecord**: 原始 hook 输入记录，包含通用上下文字段与事件专有字段
- **MappedStandardFields**: 归一化后的标准字段集合，用于跨事件统一检索与统计
- **CursorHookOutputRecord**: 单条输出 JSONL 记录，包含顶层元信息与合并后的 `data`
- **MappedSourceFieldsSet**: 标记“已被映射消费”的源字段集合，用于输出清理策略

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 对已配置事件的样例输入处理成功率达到 100%，并生成符合结构约束的 JSONL 记录
- **SC-002**: 关键映射字段（会话 ID、模型、工具参数/结果、错误类型）在样例验证中准确率达到 100%
- **SC-003**: 针对空输入、非法 JSON、处理异常、写入失败四类故障场景，主流程阻塞率为 0%
- **SC-004**: 规范声明的事件范围与 Cursor 生效 hook 配置一致率为 100%
- **SC-005**: 在启用 `listeners.cursor-hook` 且至少一个 flusher（SLS/JSONL）开启的配置下，Cursor 数据可被成功消费并进入对应输出目标

## Assumptions

- Cursor 各 hook 事件会通过 stdin 传入单条 JSON payload
- `node` 运行时在 hook 执行环境可用
- 日志目录默认位于 `~/.ai-agent-collector/logs/cursor-hook/history/`，且可按需由环境变量覆盖数据根目录
- 本阶段已扩展包含 `src/` 输入源注册与编排接入，复用既有 SLS/JSONL 输出能力
- 合规与敏感信息治理由下游消费或后续阶段处理，本阶段不在采集侧默认脱敏
