# Implementation Plan: Cursor Hook Agent

**Branch**: `105-agent-cursor` | **Date**: 2026-04-27 | **Spec**: `specs/105-agent-cursor/spec.md`
**Input**: Feature specification from `specs/105-agent-cursor/spec.md`

## Summary

本特性先完成 Cursor Hook 的统一采集链路（单入口脚本、多事件 payload、按日 JSONL 落盘、fail-open），并在此基础上扩展 `src` 层输入源接入：通过 `CursorHookInput` 消费 hook 日志，注册到 orchestrator，复用既有 SLS/JSONL flusher 上报通路。本文档同时固化两项澄清：正文类字段默认完整保留、日志保留天数可配置且默认 90 天。

## Technical Context

**Language/Version**: Node.js 22+（运行 hook 脚本与 processor），TypeScript 5.3+（主项目 strict 模式）  
**Primary Dependencies**: Node.js 标准库（`fs/promises`、`path`、`os`、`crypto`），项目测试框架 Vitest  
**Storage**: 本地文件（`~/.ai-agent-collector/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl`）  
**Testing**: Shell 冒烟验证 + Vitest（后续任务阶段补充自动化测试）  
**Target Platform**: macOS / Linux 本地开发环境  
**Project Type**: 后台数据采集系统中的 hook 采集子能力  
**Performance Goals**: 单次 hook 处理维持低延迟（目标 <50ms 常见 payload），主流程阻塞率 0%，事件处理成功率 100%（对合法输入）  
**Constraints**: fail-open、增量追加写文件、字段映射稳定、默认保留原始正文、保留周期可配置（默认 90 天）  
**Scale/Scope**: 覆盖 20 类 Cursor hook 事件，包含 `assets/hooks`、`src` 输入源接入与 `specs/105-agent-cursor` 文档产物

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 设计前 | 设计后 | 说明 |
|------|--------|--------|------|
| I. 代码质量 | ✅ 通过 | ✅ 通过 | 采集逻辑维持分层（shell 入口 / processor 映射），新增规则不引入跨层耦合 |
| II. 测试规范 | ⚠️ 部分通过 | ⚠️ 部分通过 | 已有手工冒烟验证；自动化单元/集成测试将在 `/speckit-tasks` 阶段补齐 |
| III. 用户体验一致性 | ✅ 通过 | ✅ 通过 | 采集异常一律 fail-open，不影响主流程；输出结构与命名保持一致 |
| IV. 性能要求 | ✅ 通过 | ✅ 通过 | 使用增量追加写入与轻量解析；不引入阻塞式外部依赖调用 |

**Gate 判定**: 通过（唯一待补项为自动化测试任务，不阻塞计划产出）

## Project Structure

### Documentation (this feature)

```text
specs/105-agent-cursor/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cursor-hook-input.md
│   └── cursor-hook-output.md
└── tasks.md
```

### Source Code (repository root)

```text
assets/
└── hooks/
    ├── cursor-hook.sh              # 统一 hook 入口脚本
    └── cursor-hook-processor.mjs   # 字段映射与 JSONL 追加写入

src/
├── inputs/base/base-hook-input.ts      # 现有 hook-jsonl 基类
├── inputs/cursor-hook/cursor-hook-input.ts  # Cursor Hook JSONL 输入源
├── core/orchestrator.ts               # 注册 cursor-hook 输入源
└── core/config-loader.ts              # listeners 默认配置（含 cursor-hook）

tests/
├── integration/hook-jsonl-flow.test.ts
├── unit/inputs/base-hook-input.test.ts
├── unit/inputs/cursor-hook-input.test.ts
├── unit/core/orchestrator.test.ts
└── unit/core/config-loader.test.ts
```

**Structure Decision**: 采用单项目结构，当前阶段实现并验证 `assets/hooks` + `src` 输入源接入 + `specs/105-agent-cursor` 文档。Cursor hook 配置属于本机环境配置（项目级或用户级），不要求作为仓库必需文件提交。

## Phase 0: Research & Decisions

1. 保留并扩展 `specs/105-agent-cursor/research.md`，沉淀映射表、字段清理、冲突优先级和 fail-open 规则。  
2. 补充两项澄清决策：正文类字段默认完整保留；日志保留天数可配置（默认 90 天）。  
3. 明确扩展分界：在 hooks 链路稳定后，引入 `CursorHookInput` 并完成 orchestrator/config 注册。  

## Phase 1: Design & Contracts

1. 产出 `data-model.md`：定义 `CursorHookRecord`、`MappedStandardFields`、`CursorHookOutputRecord`、`RetentionPolicy`。  
2. 产出 `contracts/`：  
   - `cursor-hook-input.md`：输入 payload 结构、兼容类型与约束。  
   - `cursor-hook-output.md`：输出 JSONL 结构、映射清理和 fail-open 响应约定。  
3. 产出 `quickstart.md`：本地配置、运行、校验和故障排查流程。  
4. 更新 `.cursor/rules/specify-rules.mdc` 中 SPECKIT 计划引用到 `specs/105-agent-cursor/plan.md`。  

## Complexity Tracking

无宪法违规项，无需复杂度豁免。
