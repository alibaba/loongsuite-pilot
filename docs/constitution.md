# LoongSuite Pilot — Baseline Constitution

> 本文档是项目架构的权威参考。所有模块文档（`modules/`）均以本文为顶层约束。

---

## 1. 项目概述 (Project Overview)

LoongSuite Pilot 是一个**多智能体 AI 编码数据采集器**（multi-agent AI coding data collector）。

- **形态**：轻量守护进程（daemon），持续轮询多种 AI coding agent 的输出
- **数据源**：IDE 历史文件、SQLite 数据库、Hook JSONL 文件、Session 日志
- **标准化**：所有原始数据归一化为 `AgentActivityEntry` 事件
- **输出目标**：Aliyun SLS logstore、本地 JSONL 文件、外部 HTTP endpoint

技术栈：TypeScript (ESM-only)、Node.js、vitest、pino logger。

---

## 2. 架构原则 (Architecture Principles)

| 原则 | 说明 |
|------|------|
| Event-driven | 基于 `EventEmitter`，组件间通过事件解耦 |
| Extensible abstractions | Input / Flusher 均有 base class 层次结构，新增类型仅需继承 |
| Checkpoint persistence | `StateStore`（偏移量）+ `SnapshotStore`（去重快照）保证重启恢复 |
| 3-layer config priority | env vars > config file > built-in defaults |
| Graceful lifecycle | start → collect → stop；异常时 restart recovery |

---

## 3. 数据流 (Data Pipeline)

```
Agent Output (IDE files, SQLite, Hooks, Session logs)
    ↓
Input Source (BaseIdeInput / BaseSqliteInput / BaseHookInput / BaseSessionInput / BaseCliForwarder)
    ↓
State Tracking (StateStore for offsets; SnapshotStore for dedup)
    ↓
Normalization (entry-builder → AgentActivityEntry schema 转换)
    ↓
InputManager (routing-only: 路由 entries 至 flusher)
    ↓
MultiFlusher (routes to SLS / JSONL / HTTP in parallel)
    ↓
Output (Local JSONL files, SLS logstore, external HTTP endpoint)
```

关键点：
- 每个 Input Source 自行管理轮询节奏和 checkpoint
- `InputManager` 是唯一的 entry 出口——禁止绕过
- `MultiFlusher` 并行写入所有已注册 flusher，单个失败不阻塞其他

---

## 4. 模块路由图 (Module Routing Map)

根据变更意图，定位需阅读的模块文档：

| 变更场景 | 相关模块文档 |
|----------|-------------|
| 添加新的 input source | `inputs.md`, `types.md`, `core.md` |
| 添加新的 output target | `flushers.md`, `types.md` |
| 修改数据 schema | `normalization.md`, `types.md`, `checkpoints.md` |
| 修改配置 | `core.md`（config-loader section） |
| 修改 hook 行为 | `hooks.md`, `core.md` |
| Auto-update 相关 | `updater.md` |

---

## 5. 扩展模式 (Extension Patterns)

### 5.1 添加新 Input Source

1. 选择合适的 base class（`BaseIdeInput` / `BaseSqliteInput` / `BaseHookInput` / `BaseSessionInput` / `BaseCliForwarder`）
2. 在 `src/inputs/<new-source>/` 下创建实现
3. 实现 `collect()` 方法，返回标准化 entries
4. 在 `Orchestrator` 中注册该 input

### 5.2 添加新 Flusher

1. 继承 `BaseFlusher`，实现 `flush(entries)` 方法
2. 在 `MultiFlusher` 的 flusher 列表中注册
3. 处理好错误——单个 flusher 失败不应影响整体 pipeline

### 5.3 添加新 Agent 类型

1. 创建对应的 input 实现（参见 5.1）
2. 在 `Orchestrator` 的 input 注册逻辑中添加该 agent 的条件分支
3. 确保 `AgentActivityEntry.clientType` 中有对应枚举值（`src/types/client-type.ts`）

---

## 6. 质量标准 (Quality Gates)

- **TypeScript strict mode**：`tsconfig.json` 中 `strict: true`
- **Module target**：ES2022 + NodeNext module resolution
- **测试框架**：vitest（unit / integration / contract）
- **Contract tests**：验证 `AgentActivityEntry` schema 的稳定性
- **覆盖要求**：所有 input 必须在 `tests/unit/inputs/` 下有对应单元测试
- **编译检查**：`npm run typecheck` 必须通过

---

## 7. 配置约定 (Configuration Conventions)

**三层优先级**（高 → 低）：

1. 环境变量
2. 配置文件 `~/.loongsuite-pilot/config.json`
3. 内置默认值

**命名规则**：

| 类型 | 模式 | 示例 |
|------|------|------|
| 主设置 | `LOONGSUITE_PILOT_*` | `LOONGSUITE_PILOT_USER_ID` |
| Agent 轮询 | `<AGENT>_ANALYTICS_POLL_INTERVAL` | `QODER_ANALYTICS_POLL_INTERVAL` |
| 布尔值 | `"true"` / `"false"` 字符串 | `LOONGSUITE_PILOT_ENABLED=false` |
| 日志保留 | `LOONGSUITE_PILOT_LOG_RETENTION_*` | `LOONGSUITE_PILOT_LOG_RETENTION_DAYS` |

---

## 8. 约束与禁忌 (Constraints and Anti-patterns)

| ❌ 禁止 | 原因 |
|---------|------|
| 使用 CommonJS `require()` | 项目为 ESM-only |
| 在主事件循环中执行同步 I/O | 阻塞采集与 flush 调度 |
| 绕过数据管道直接 flush entries | 破坏 hook 层的数据富化与策略控制 |
| 在输出 entry 中存储敏感数据（token、key）而不经 content-policy redaction | 数据泄露风险 |
| 破坏 BaseInput 生命周期契约（init → start → collect → stop） | 导致 checkpoint 丢失或重复采集 |
| 修改 StateStore / SnapshotStore 格式而不提供迁移逻辑 | 破坏重启恢复能力 |

---

## 9. 与 README 的关系 (Relationship to README.md)

| 文档 | 定位 | 内容 |
|------|------|------|
| `README.md` | 运维 / 入门文档 | 如何 build、deploy、run、configure |
| `docs/` | 架构 / 结构文档 | 系统是什么、如何设计、有哪些约束 |

两者**不重叠**——各司其职，避免信息冗余。
