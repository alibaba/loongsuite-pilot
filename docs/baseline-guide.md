# Baseline 文档使用指南

> Baseline docs = 项目架构的稳定真相（stable architectural truth）

## Quick Reference

| 文件 | 用途 | 何时阅读 |
|------|------|----------|
| `constitution.md` | 项目宪法：架构全景、原则、约束 | 每次变更前 |
| `modules/*.md` | 模块级描述：接口、设计模式、约束 | 实现涉及该模块时 |
| `modules/runtime.md` | 安装、CLI、服务管理、版本指针、运行时部署 | 改 installer / CLI / daemon / autostart / rollback 时 |
| `modules/monitor.md` | 本地 dashboard、进程采样、健康状态展示 | 改 monitor UI/API/metrics 时 |
| 本文件 | 使用指南 | 首次接触 baseline 时 |

---

## 1. 什么是基准文档 (What are Baseline Docs)

Baseline docs 描述项目架构的**当前状态**（as-is），而非期望状态。

- 它们是项目的"宪法"——关于模块边界和约束的稳定事实
- 与 OpenSpec changes 互补：**baseline = what IS**，**changes = what to CHANGE**
- 为 AI agent 和人类开发者提供一致的架构认知基础

## 2. 文档结构 (Document Structure)

```
docs/
├── README.md          ← 本文件（使用指南）
├── constitution.md    ← 项目宪法：overall architecture, principles, constraints
└── modules/
    ├── core.md        ← collector 编排、配置、agent lifecycle
    ├── inputs.md      ← input source 采集策略
    ├── normalization.md
    ├── flushers.md
    ├── checkpoints.md
    ├── hooks.md
    ├── updater.md
    ├── runtime.md     ← installer / CLI / bootstrap / service lifecycle
    └── monitor.md     ← dashboard / process metrics / health overview
```

## 3. 如何在开发中使用 (How to Use During Development)

| 阶段 | 操作 |
|------|------|
| **opsx-propose**（提案） | 阅读 constitution 的 routing map，识别受影响模块，再阅读对应 module docs |
| **opsx-apply**（实现） | Module docs 作为架构约束——遵守它们 |
| **opsx-explore**（探索） | 使用 constitution 获取高层架构认知 |
| **opsx-archive**（归档） | 检查 baseline 是否需要更新 |

## 4. 不可变性原则 (Immutability Principle)

Baseline 遵循**非必要不修改**原则——除非变更本身有意改变架构，否则不动 baseline。

如果确实需要修改，流程如下：

1. 在 proposal 中声明 "Baseline Modification" 并说明理由
2. 获得人类确认后方可继续
3. **先**实现代码变更
4. **最后**更新 baseline docs（需人类 review）
5. Archive 步骤验证：若声明了修改，确认 baseline 已更新

## 5. 过期检测 (Staleness Detection)

每个 module doc 包含 `Last verified: YYYY-MM-DD` 日期。

当 agent 发现代码与 module doc 描述不一致时：

- **Flag** it for human review
- **不要**静默忽略差异
- **不要**自动更新 baseline

过期不阻塞开发，但应被追踪记录。

## 6. 与 OpenSpec 的关系 (Relationship to OpenSpec)

- `openspec/config.yaml` 的 context 字段引用 baseline docs
- Proposal artifacts 包含 "Affected Baseline Modules" section
- Task artifacts 包含 baseline validation task
- 所有 openspec 命令（propose, apply, archive, explore）加载相关 baseline docs 作为 context

## 7. 与 README.md 的关系 (Relationship to Project README)

| | Project README.md | Baseline docs |
|---|---|---|
| 性质 | Operational（运维） | Architectural（架构） |
| 内容 | Build, deploy, run, configure | Design, structure, constraints |
| 受众 | 运行项目的人 | 修改项目的人 |

两者之间**无内容重复**。
