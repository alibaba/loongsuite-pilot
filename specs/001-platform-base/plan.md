# Implementation Plan: 平台基础设施（Platform Base）

**Branch**: `feature/taiye/spec_driven` | **Date**: 2026-04-27 | **Spec**: `specs/001-platform-base/spec.md`
**Input**: Feature specification from `specs/001-platform-base/spec.md`

## Summary

平台基础设施覆盖 AI Agent Collector 的全部基础层：输入源采集框架（5 种基类）、持久化层（StateStore + SnapshotStore）、归一化层（entry-builder + 序列化 + 脱敏）、数据输出（JSONL/SLS/HTTP + MultiFlusher）、核心编排（Orchestrator + Discovery + Config + InputManager）。所有模块已有完整的生产代码实现，输入源框架和持久化层已有充分的单元测试和集成测试覆盖（174 个测试，覆盖率 85%+），下一步需要补充归一化层、数据输出和核心编排层的测试，以达到宪法要求的 80% 全局覆盖率。

## Technical Context

**Language/Version**: TypeScript 5.3+ (strict mode, ES2022 target, NodeNext modules)
**Primary Dependencies**: `better-sqlite3`（SQLite 读取）、`@alicloud/log`（SLS 输出）、`axios`（HTTP 输出）、`uuid`（UUID 生成）、`zod`（schema 校验）
**Storage**: JSON 文件持久化（StateStore/SnapshotStore）、SQLite 只读（Qoder chat_record）
**Testing**: Vitest 1.6.0 + @vitest/coverage-v8（已配置，80% 阈值）
**Target Platform**: Node.js 18+，macOS / Linux
**Project Type**: 后台守护进程（daemon）
**Performance Goals**: 稳态 RSS < 150MB，轮询间隔 30-60s，优雅关闭 < 15s
**Constraints**: 增量读取（禁止全文件重读），批量刷写（禁止单条刷写），事件循环不阻塞 > 50ms
**Scale/Scope**: 4 种 Agent 并行采集，3 种输出通道同时启用

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 状态 | 说明 |
|------|------|------|
| I. 代码质量 | ✅ 通过 | strict 模式已启用，`tsc --noEmit` 零错误，模块分层清晰（inputs/flushers/normalization/core），生命周期通过 `start`/`stop` 管理 |
| II. 测试规范 | ⚠️ 部分通过 | inputs + checkpoints 已有 174 个测试（85%+覆盖率）；flushers、normalization、core 尚无测试覆盖 |
| III. 用户体验一致性 | ✅ 通过 | 配置优先级链（env > file > default）已在 ConfigLoader 中实现，结构化 JSON 日志已统一使用，插件架构已就绪 |
| IV. 性能要求 | ✅ 通过 | 增量读取（offset/rowid），批量刷写（SLS/HTTP），快照过期清理，轮询间隔可配置 |

**Gate 判定**: 通过（测试缺口已识别，将在 tasks 阶段补充）

## Project Structure

### Documentation (this feature)

```text
specs/001-platform-base/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── base-input.md
│   └── collection-methods.md
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
src/
├── inputs/
│   └── base/
│       ├── base-input.ts           # 抽象基类：轮询循环 + 事件发射
│       ├── base-hook-input.ts      # Hook JSONL 日志采集
│       ├── base-session-input.ts   # 会话文件轮询（inode 检测）
│       ├── base-ide-input.ts       # IDE 历史快照 + SnapshotStore 去重
│       ├── base-sqlite-input.ts    # SQLite 增量轮询（待绑定 Agent）
│       └── base-cli-forwarder.ts   # CLI 遥测转发（待绑定 Agent）
├── checkpoints/
│   ├── state-store.ts              # 多维度采集进度持久化
│   └── snapshot-store.ts           # IDE 快照去重 + 过期清理
├── normalization/
│   └── entry-builder.ts            # buildAgentActivityEntry + serialise + redact
├── flushers/
│   ├── base-flusher.ts             # 抽象输出接口
│   ├── multi-flusher.ts            # 多目标扇出（Promise.allSettled 隔离）
│   ├── jsonl-flusher.ts            # 本地 JSONL 文件输出
│   ├── sls-flusher.ts              # 阿里云 SLS 输出 + 失败持久化
│   └── http-flusher.ts             # HTTP POST 输出 + 重试缓冲
├── core/
│   ├── orchestrator.ts             # 中枢编排器
│   ├── config-loader.ts            # 三层配置合并
│   ├── input-manager.ts            # 输入源注册 + 事件分发
│   ├── agent-discovery-service.ts  # fs.watch + 轮询发现
│   └── agent-control-manager.ts    # 三级准入控制
├── types/
│   ├── index.ts                    # 全局类型定义
│   ├── client-type.ts              # ClientType / ActionType 枚举
│   └── events.ts                   # 事件类型
└── utils/
    ├── logger.ts                   # 结构化 JSON 日志
    ├── fs-utils.ts                 # 文件系统工具
    └── git-resolver.ts             # Git 仓库信息解析

tests/
├── contract/                       # 契约测试 ✅ 已有
├── integration/                    # 集成测试 ✅ 已有（inputs/checkpoints）
├── unit/
│   ├── inputs/                     # 输入源单元测试 ✅ 已有
│   ├── checkpoints/                # 持久化层单元测试 ✅ 已有
│   ├── normalization/              # 归一化层单元测试 ❌ 待补充
│   ├── flushers/                   # 输出层单元测试 ❌ 待补充
│   └── core/                       # 编排层单元测试 ❌ 待补充
└── helpers/                        # 测试工具 ✅ 已有
```

**Structure Decision**: 采用单项目结构，源码在 `src/`，测试在 `tests/`，按模块对齐目录。已有 inputs + checkpoints 的完整测试，需补充 normalization、flushers、core 三个模块的测试目录。
