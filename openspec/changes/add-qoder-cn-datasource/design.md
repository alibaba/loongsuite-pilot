## Context

QoderCN（国内版 Qoder）是一个独立的桌面 IDE 应用，内置 `qodercncli` agent 组件。经过调研确认：

- SQLite 数据库 schema 与 Qoder **完全一致**（`chat_message` 表，`local.db`）
- IDE 数据结构一致（`User/History/`、`ai_tracker/`）
- CLI hook 机制一致（transcript JSONL + Stop event），仅配置路径不同（`~/.qoder-cn/settings.json`）

因此可以 100% 复用现有 base class，仅需替换路径常量和 agent 标识。

## Goals / Non-Goals

**Goals:**
- 为 QoderCN 添加完整的数据采集覆盖（SQLite token + IDE snapshot + Hook JSONL）
- 复用 `BaseSqliteInput` 和 `BaseIdeInput`，新 Input 仅改路径
- 通过 agent 定义文件（`agents.d/qoder-cn.json`）驱动 hook 部署
- 在 `hook-processor.mjs` 中添加 `qoder-cn` 分支路由

**Non-Goals:**
- 不修改现有 Qoder/QoderWork 的采集逻辑
- 不引入新的 base class 或抽象
- 不改变数据管道（InputManager → Flusher）的流转方式
- QoderWork CN 数据源在本次范围之外（已在其他分支处理）

## Decisions

### D1: 路径常量

| 项 | Qoder | QoderCN |
|----|-------|---------|
| Data root (macOS) | `~/Library/Application Support/Qoder` | `~/Library/Application Support/QoderCN` |
| Data root (Linux) | `~/.config/Qoder` | `~/.config/QoderCN` |
| CLI config | `~/.qoder` | `~/.qoder-cn` |
| Settings file | `~/.qoder/settings.json` | `~/.qoder-cn/settings.json` |
| DB relative path | `SharedClientCache/cache/db/local.db` | 同上 |
| ai_tracker | `SharedClientCache/cache/ai_tracker/*.jsonl` | 同上 |

**Why**: 调研确认 QoderCN 使用不同的顶层目录名但内部结构完全相同。

### D2: 新增 ClientType 枚举

在 `src/types/client-type.ts` 的 IDE tools 分组添加：

```typescript
QoderCn = 'qoder-cn',
```

**Why**: 每个数据源需要独立的 `ClientType` 值以区分采集来源。Hook-based 的 `QoderCnHook` 也需要单独的枚举值。

在 Hook-based tools 分组添加：

```typescript
QoderCnHook = 'qoder-cn-hook',
```

### D3: QoderCN SQLite Input

克隆 `src/inputs/qoder-sqlite/qoder-sqlite-input.ts`，创建 `src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.ts`：

- 替换路径常量：`'Qoder'` → `'QoderCN'`
- 替换 `id`：`'qoder-sqlite'` → `'qoder-cn-sqlite'`
- 替换 `agentType`：`ClientType.Qoder` → `ClientType.QoderCn`
- 替换 `SOURCE` 常量：`'qoder-cn-sqlite-chat-message'`
- 环境变量：`QODER_CN_ANALYTICS_POLL_INTERVAL`

无需修改查询 SQL 或数据转换逻辑。

### D4: QoderCN IDE Input

克隆 `src/inputs/qoder/qoder-input.ts`，创建 `src/inputs/qoder-cn/qoder-cn-input.ts`：

- 替换路径常量：`'Qoder'` → `'QoderCN'`
- 替换 `id`：`'qoder'` → `'qoder-cn'`
- 替换 `agentType`：`ClientType.Qoder` → `ClientType.QoderCn`
- stateStore key 前缀：`'qoder-cn-tracker:'`
- 日志路径：`~/.loongsuite-pilot/logs/qoder-cn/qoder-cn-snapshot-store.json`

### D5: Hook Script + Agent Definition

**Hook script**: 复制 `assets/hooks/qoder-loongsuite-pilot-hook.sh` → `assets/hooks/qodercn-loongsuite-pilot-hook.sh`，默认 `AGENT_ID="qoder-cn"`。

**Agent 定义** (`agents.d/qoder-cn.json`):

```json
{
  "id": "qoder-cn",
  "displayName": "QoderCN",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.qoder-cn"],
    "commands": []
  },
  "hook": {
    "settingsPath": "~/.qoder-cn/settings.json",
    "events": ["Stop"],
    "hookCommand": "$PILOT_DATA/hooks/qodercn-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/qoder-cn/history"
  }
}
```

### D6: hook-processor.mjs 路由

在 `assets/hooks/agent-event-normalizer.mjs` 的 `normalizeTranscriptRecord()` 函数中，`agentId` 路由添加 `'qoder-cn'` 分支，复用 `buildQoderHookRecord()`（传入 `'qoder-cn'` 作为 agent type）。

### D7: Orchestrator 注册

在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 中添加 QoderCN 的 SQLite 和 IDE Input 的注册逻辑，使用与 Qoder 相同的检测模式（`checkAvailability` 静态方法）。

## Risks / Trade-offs

### R1: 路径假设

- **Risk**: QoderCN 未来版本可能改变数据目录位置
- **Mitigation**: 路径常量集中定义，后续可轻松修改。agent 定义文件也可被用户覆盖。

### R2: Hook settings.json 不存在

- **Risk**: 用户未充分使用 QoderCN 时 `~/.qoder-cn/settings.json` 可能不存在
- **Mitigation**: DeploymentManager 的 HookStrategy 已处理此情况——若 settings 文件不存在会自动创建。检测仅依赖 `~/.qoder-cn` 目录存在。
