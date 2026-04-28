# Tasks: Cursor Hook Agent

**Input**: Design documents from `/specs/105-agent-cursor/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: 包含测试任务（依据项目宪法的测试门禁与本特性成功标准）。  
**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立 Cursor Hook 特性的开发与验证基础。

- [X] T001 对齐并确认当前 feature 上下文为 `specs/105-agent-cursor`（检查 `.specify/feature.json`）
- [X] T002 整理并校验规划文档交叉引用（`specs/105-agent-cursor/plan.md`, `specs/105-agent-cursor/research.md`, `specs/105-agent-cursor/spec.md`）
- [X] T003 [P] 准备本地回归脚本片段并更新 `specs/105-agent-cursor/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 完成所有用户故事共享的底层约束与测试骨架。  
**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 在 `assets/hooks/cursor-hook.sh` 固化 fail-open 入口约束（空输入/缺 processor/缺 node 均返回 `{}`）
- [X] T005 在 `assets/hooks/cursor-hook-processor.mjs` 固化统一响应契约（成功与失败路径均输出 `{}` 且 exit 0）
- [X] T006 [P] 在 `tests/unit/inputs/base-hook-input.test.ts` 增补通用 Hook JSONL 读取边界测试（空文件、无效 JSONL 行）
- [X] T007 [P] 在 `tests/integration/hook-jsonl-flow.test.ts` 增补 Cursor Hook 端到端流的基础断言骨架
- [X] T008 对齐并验证 `.cursor/rules/specify-rules.mdc` 的计划引用保持 `specs/105-agent-cursor/plan.md`

**Checkpoint**: Foundation ready - 用户故事可并行推进。

---

## Phase 3: User Story 1 - 采集 Cursor Hook 事件日志 (Priority: P1) 🎯 MVP

**Goal**: 统一入口接收多事件 payload，并按天追加写入 Cursor JSONL 日志。  
**Independent Test**: 输入合法 payload 后，生成 `cursor-YYYY-MM-DD.jsonl` 且记录结构完整。

### Tests for User Story 1

- [X] T009 [P] [US1] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加“合法 payload 产生日志行”测试
- [X] T010 [P] [US1] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加“同日多次触发为追加写入”测试

### Implementation for User Story 1

- [X] T011 [US1] 在 `assets/hooks/cursor-hook.sh` 完成统一入口与 processor 管道行为
- [X] T012 [US1] 在 `assets/hooks/cursor-hook-processor.mjs` 完成输出记录顶层结构（`uuid/logTime/reported/clientType/hookEvent/data`）
- [X] T013 [US1] 在 `specs/105-agent-cursor/contracts/cursor-hook-output.md` 更新与实现一致的样例与字段说明

**Checkpoint**: US1 可独立运行并产出标准日志记录。

---

## Phase 4: User Story 2 - 标准字段映射与兼容输出 (Priority: P1)

**Goal**: 实现稳定映射、源字段清理与兼容解析策略。  
**Independent Test**: `postToolUse/postToolUseFailure/afterAgentResponse` 样例输入均得到一致映射输出。

### Tests for User Story 2

- [X] T014 [P] [US2] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加 `session_id/conversation_id` 映射优先级测试
- [X] T015 [P] [US2] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加 `tool_input/tool_output/result_json` 兼容解析测试
- [X] T016 [P] [US2] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加源字段清理与冲突键“spec wins”测试

### Implementation for User Story 2

- [X] T017 [US2] 在 `assets/hooks/cursor-hook-processor.mjs` 完成 `mapStandardFields()` 与 `mergeData()` 的完整规则对齐
- [X] T018 [US2] 在 `assets/hooks/cursor-hook-processor.mjs` 完成 `inferRole()` 的事件族覆盖（含 before/after shell/mcp）
- [X] T019 [US2] 在 `specs/105-agent-cursor/research.md` 同步最终映射表与清理字段清单

**Checkpoint**: US2 映射规则可独立验证并稳定输出。

---

## Phase 5: User Story 3 - Fail-Open 运行保障 (Priority: P2)

**Goal**: 采集失败不影响 Cursor 主流程。  
**Independent Test**: 空输入、非法 JSON、写入失败等场景均返回 `{}` 且成功退出。

### Tests for User Story 3

- [X] T020 [P] [US3] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加空输入场景测试
- [X] T021 [P] [US3] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加非法 JSON 场景测试
- [X] T022 [P] [US3] 在 `tests/integration/hook-jsonl-flow.test.ts` 添加追加写入异常场景测试（mock 文件写入失败）

### Implementation for User Story 3

- [X] T023 [US3] 在 `assets/hooks/cursor-hook.sh` 强化所有故障分支的 fail-open 返回
- [X] T024 [US3] 在 `assets/hooks/cursor-hook-processor.mjs` 统一故障分支响应并补充注释说明
- [X] T025 [US3] 在 `specs/105-agent-cursor/contracts/cursor-hook-input.md` 与 `specs/105-agent-cursor/contracts/cursor-hook-output.md` 固化 fail-open 契约

**Checkpoint**: US3 异常路径行为可独立测试并满足阻塞率 0% 目标。

---

## Phase 6: User Story 4 - 事件覆盖与配置一致性 (Priority: P2)

**Goal**: 规范中的事件覆盖与配置保持一致。  
**Independent Test**: 对照清单核对事件键与绑定命令，不存在缺失/多余项。

### Tests for User Story 4

- [X] T026 [P] [US4] 在 `tests/integration/hook-jsonl-flow.test.ts` 增加事件覆盖校验（至少抽样关键事件族）

### Implementation for User Story 4

- [X] T027 [US4] 对齐 `specs/105-agent-cursor/spec.md` 与 `specs/105-agent-cursor/contracts/cursor-hook-input.md` 的事件清单
- [X] T028 [US4] 在 `specs/105-agent-cursor/quickstart.md` 增加事件覆盖核验步骤与命令说明
- [X] T029 [US4] 在 `specs/105-agent-cursor/research.md` 记录事件扩展时的同步维护规则

**Checkpoint**: US4 配置与规范一致性可独立检查通过。

---

## Phase 7: User Story 5 - 接入统一上报通路 (Priority: P1)

**Goal**: 将 hooks 落盘数据接入 `src` 主程序输入与统一上报链路（SLS/JSONL）。  
**Independent Test**: 启用 `listeners.cursor-hook` 后，`cursor-hook` 日志被消费并进入已启用 flusher 输出。

### Tests for User Story 5

- [X] T037 [P] [US5] 在 `tests/unit/inputs/cursor-hook-input.test.ts` 增加输入源单测
- [X] T038 [P] [US5] 在 `tests/integration/hook-jsonl-flow.test.ts` 增加“hook 写入 -> CursorHookInput 消费”闭环测试
- [X] T039 [P] [US5] 在 `tests/unit/core/orchestrator.test.ts` 与 `tests/unit/core/config-loader.test.ts` 增加接入回归覆盖

### Implementation for User Story 5

- [X] T034 [US5] 新增 `src/inputs/cursor-hook/cursor-hook-input.ts`，实现 Cursor Hook JSONL 到 `AgentActivityEntry` 的转换
- [X] T035 [US5] 在 `src/core/orchestrator.ts` 注册 `cursor-hook` 输入源并接入 `InputManager`
- [X] T036 [US5] 在 `src/core/config-loader.ts` 增加 `listeners.cursor-hook` 默认配置
- [X] T040 [US5] 更新 `README.md` 与 `specs/105-agent-cursor/quickstart.md`，补充 `cursor-hook` listener 与上报链路说明

**Checkpoint**: Cursor 数据可通过 `cursor-hook` listener 进入统一 flusher 通路，按配置输出到 SLS/JSONL。

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 收尾验证、文档同步与质量门禁。

- [X] T030 [P] 汇总并更新 `specs/105-agent-cursor/checklists/requirements.md` 与最新规格一致
- [X] T031 运行 `npm run typecheck` 并修复本特性引入的问题
- [X] T032 运行 `npm test -- tests/integration/hook-jsonl-flow.test.ts` 验证关键回归
- [X] T033 逐步执行 `specs/105-agent-cursor/quickstart.md` 的命令并确认文档可复现

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): 可立即开始。
- Phase 2 (Foundational): 依赖 Phase 1，且阻塞所有用户故事。
- Phase 3-6 (US1-US4): 依赖 Phase 2 完成；US1/US2 建议先完成以稳定主链路，US3/US4 可并行推进。
- Phase 7 (US5): 依赖 Phase 3-6 完成后推进，确保 hooks 链路稳定再做编排接入。
- Phase 8 (Polish): 依赖 US1-US5 完成后执行，做最终质量门禁与回归验证。

### User Story Dependencies

- **US1 (P1)**: 依赖 Foundational，无需依赖其他故事。
- **US2 (P1)**: 依赖 US1 产出的基础记录结构。
- **US3 (P2)**: 依赖 US1/US2 的主链路实现后补充失败分支保障。
- **US4 (P2)**: 可在 US1/US2 稳定后执行一致性对齐。
- **US5 (P1)**: 依赖 US1-US4 的 hooks 侧稳定产物，再完成 `src` 输入源与上报链路接入。

### Within Each User Story

- 先补测试任务，再补实现任务，再更新契约/文档。
- 涉及同文件改动的任务按顺序执行，避免冲突。

---

## Parallel Opportunities

- Phase 1 的文档类任务 `T003` 可并行。
- Phase 2 的测试骨架任务 `T006`、`T007` 可并行。
- US2 测试任务 `T014`、`T015`、`T016` 可并行。
- US3 测试任务 `T020`、`T021`、`T022` 可并行。
- 收尾阶段 `T030` 与部分验证准备可并行。

---

## Parallel Example: User Story 2

```bash
Task: "在 tests/integration/hook-jsonl-flow.test.ts 添加 session 映射优先级测试"
Task: "在 tests/integration/hook-jsonl-flow.test.ts 添加 tool_input/tool_output/result_json 兼容解析测试"
Task: "在 tests/integration/hook-jsonl-flow.test.ts 添加源字段清理与冲突键 spec wins 测试"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. 完成 Phase 1 + Phase 2。  
2. 交付 US1（日志可稳定产出）。  
3. 交付 US2（映射规则稳定）。  
4. 运行关键回归并确认可作为 MVP。

### Incremental Delivery

1. MVP（US1+US2）先落地。  
2. 增量补齐 US3（fail-open 边界）与 US4（一致性治理）。  
3. 扩展交付 US5（input + orchestrator + reporting 通路）。  
4. 最后执行全量质量门禁与回归。

### Notes

- 任务包含 hooks 采集与 `src` 编排接入扩展（`CursorHookInput` + orchestrator/config wiring）。
- `FR-011` 的 retention cleanup 实现可在本特性内做最小实现，或拆分到后续任务并在文档显式说明。
