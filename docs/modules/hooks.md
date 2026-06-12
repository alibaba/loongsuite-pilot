# Module: hooks

> Last verified: 2026-05-13

## 职责 (Responsibility)

Hook 脚本管理层，负责将数据采集 hook 脚本注入到各 AI coding agent 的配置文件中，使其在关键事件时触发数据上报。

## 公共接口 (Public Interface)

- **HookDefinition** — Hook 定义接口，描述一个 agent hook 的完整信息：目标 agent 标识、settings 文件路径、JSON 导航路径、hook 命令、匹配器以及格式标志。
- **HookManager** — Hook 脚本管理器，提供 hook 的安装、卸载和安装状态检查能力。同时通过静态工厂方法为已知 agent（Cursor、Qoder CLI、QoderWork）生成预定义的 HookDefinition 列表，也提供通用模板用于快速接入新 agent。
- **Asset hook entrypoints** (`assets/hooks/*-loongsuite-pilot-hook.sh`) — Agent 调用的 shell 入口，负责 Node runtime 解析、fail-open 行为和委派给 processor。
- **Asset hook processors** (`assets/hooks/*processor.mjs`) — Hook 事件处理器，读取 stdin payload / transcript，调用共享 normalizer 生成 standard-compatible hook record，写入 daily JSONL history。
- **Asset hook normalizer** (`assets/hooks/agent-event-normalizer.mjs`) — 共享的 dependency-free 归一化 helper，负责 timestamp/event id、source event → `event.name`、canonical dotted key 构造、raw context namespacing、best-effort `user.id`、provider fallback、content-policy filtering，以及通用 tool/status/error 映射。

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/hooks/
└── hook-manager.ts       # HookDefinition 与 HookManager

assets/hooks/
├── README.md
├── *-loongsuite-pilot-hook.sh
├── *-loongsuite-pilot-hook.ps1
├── agent-event-normalizer.mjs
├── hook-processor.mjs
└── cursor-hook-processor.mjs
```

### 运行时安装布局 (Runtime Install Layout)

```
~/.loongsuite-pilot/
├── hooks/                # postinstall 部署的 hook scripts/processors
└── logs/
    ├── qoder-cli/history/
    ├── qoder-work/history/
    ├── qoder-work-cn/history/
    └── cursor/history/
```

`HookManager` 只负责修改 agent settings；hook 脚本文件本身由 `postinstall.js` 部署到运行时目录。

### Asset Hook Pipeline

```
Agent hook event
    ↓
*-loongsuite-pilot-hook.sh        # resolve Node, never block agent on failure
    ↓
*processor.mjs                    # parse stdin/transcript, emit standard-compatible hook records
    ↓
~/.loongsuite-pilot/logs/<agent>/history/<agent>-YYYY-MM-DD.jsonl
    ↓
BaseHookInput subclass            # incremental tail + final AgentActivityEntry build/validation
```

Asset hook processors 是 agent 原始事件离开 agent 进程后的第一层边界。它们默认承载从 stdin/transcript 单条事件可确定的 deterministic per-event normalization，并通过 `agent-event-normalizer.mjs` 复用通用映射逻辑；source processor 只保留 source-specific extraction。它们不能绕过 history JSONL，也不能直接发送到 flusher。

### Hook 注入流程
1. 确保 settings 文件所在目录存在
2. 读取 agent 的 settings JSON 文件（不存在则创建空对象）
3. 沿 `hookJsonPath` 导航到目标数组位置（逐层创建缺失的对象/数组节点）
4. 检查数组中是否已存在该 command（支持 flat 和 nested 两种格式匹配）
5. 不存在则追加 hook entry，写回 settings 文件
6. 确保对应 agent 的日志目录存在

### 两种 Hook Entry 格式

**Flat 格式**（Cursor 等标准 hooks.json）：
```json
{ "type": "command", "command": "path/to/hook.sh", "matcher": "*" }
```

**Nested 格式**（Qoder CLI settings.json）：
```json
{ "matcher": "*", "hooks": [{ "command": "path/to/hook.sh", "type": "command" }] }
```

通过 `useNestedFormat` 标志控制输出格式。

### 已注册 Agent Hooks

| Agent | Settings Path | Events | Format |
|-------|--------------|--------|--------|
| Cursor | `~/.cursor/hooks.json` | stop, preToolUse, postToolUse, postToolUseFailure, beforeSubmitPrompt, preCompact, sessionStart, sessionEnd, subagentStart, subagentStop, afterAgentResponse, afterAgentThought | flat |
| Qoder CLI | `~/.qoder/settings.json` | Stop | nested |
| QoderWork | `~/.qoderwork/settings.json` | Stop | nested |

### 卸载流程
读取 settings → 过滤掉匹配 command 的条目 → 写回文件。

### Command 匹配逻辑
支持两层查找：
- `entry.command === target`（flat 格式）
- `entry.hooks[].command === target`（nested 格式）

### Asset Hook Record Contract

history JSONL 每行必须是一个 JSON object。迁移字段归一化到 hook processor 时，推荐输出 **standard-compatible hook record**：

```json
{
  "time_unix_nano": "1778586618041000000",
  "observed_time_unix_nano": "1778586618041000000",
  "event.id": "uuid-or-source-event-id",
  "event.name": "tool.result",
  "gen_ai.session.id": "session-id",
  "gen_ai.agent.type": "cursor",
  "gen_ai.tool.name": "edit_file",
  "gen_ai.tool.call.id": "tool-call-id",
  "agent.cursor.hook_event_name": "postToolUse"
}
```

字段分层约定：

- Canonical dotted keys（如 `event.name`, `user.id`, `gen_ai.*`, `error.*`）用于稳定查询字段。
- Source-specific 原始信息放在带 agent 前缀的 `agent.<source>.*` 字段，避免污染顶层 schema；已经映射到 canonical 字段的原始 key 不应重复保留。
- 消息内容、工具参数、工具结果等高敏字段只有在对应 agent policy 允许时才应完整保留；hook processor 会做 best-effort policy filtering，collector 侧仍会权威地再次执行内容策略。
- `BaseHookInput` 仍负责增量读取、checkpoint、最终调用 `buildAgentActivityEntry()` 以及向 `InputManager` 发射 entries。

兼容期内，processor 可以继续输出原始 transcript row；对应 Input 负责兼容旧格式和 standard-compatible hook record。新增 hook processor 应优先输出 standard-compatible hook record。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| utils | `readJsonFile`, `writeJsonFile`, `ensureDir`, `resolveHome`, `fileExists`, `createLogger` |
| node:fs/promises | 文件操作 |
| node:path | 路径构造 |

## 扩展指南 (Extension Guide)

### 为新 Agent 添加 Hook 支持

新增 Agent hook 需要实现一个静态工厂方法返回 HookDefinition 数组，指定 agent 的 settings 路径、hook 命令和格式。参考现有实现: [src/hooks/hook-manager.ts](../../../src/hooks/hook-manager.ts)

步骤概要：
1. 确定 agent 的 settings 文件路径和格式（通常为 `~/.agent-name/settings.json`）
2. 在 HookManager 中添加静态工厂方法
3. 创建 hook shell 脚本 `assets/hooks/my-agent-hook.sh`，调用 `hook-processor.mjs`
4. 在 `Orchestrator.installHooks()` 中调用
5. 在 `postinstall.js` 中部署 hook 脚本到 `~/.loongsuite-pilot/hooks/`

### 将字段归一化迁移到 Asset Hook

详细约定见 [assets/hooks/README.md](../../../assets/hooks/README.md)。

1. 在 processor 中解析 agent 原始 payload，调用 `agent-event-normalizer.mjs` 生成 standard-compatible hook record。
2. 默认将 stdin/transcript 单条事件可确定的字段映射为 canonical dotted keys，包括 event/session/model/token/tool/error 字段，以及 best-effort `user.id`、provider fallback、content-policy filtering。
3. 保留必要的 source context 字段，放入 `agent.<source>.*`；已转换字段不得在顶层或 source namespace 中重复保留。
4. 在对应 `BaseHookInput` 子类中优先识别 canonical dotted keys；仅对旧格式走 fallback 解析。
5. 更新或新增 contract test，覆盖 processor 输出 record 和 input fallback 兼容。
6. 确认 processor 失败时仍输出空 JSON/退出 0，并把错误写入本地 error log。

## 约束 (Constraints)

1. **Hook 安装为幂等操作**：重复安装不应产生重复条目。
2. **Settings 文件写入必须保持原有内容不变**：仅追加/删除 hook 相关条目。
3. **安装失败不得中断主流程**：返回 false 而非抛出异常。
4. **hook shell 脚本必须为可执行文件**：postinstall 时设置 chmod +x。
5. **hookJsonPath 深度无限制但须为有效 JSON path**：每个 segment 为对象 key。
6. **buildGenericHook 为通用模板**：仅适用于支持 PostToolUse 事件的 MCP-compatible 工具。
7. **Asset hook 必须 fail-open**：processor 解析、写文件、Node 缺失等错误不得阻塞原 agent。
8. **Asset hook 不得直接 flush**：只能写本地 history/error/debug 文件，输出仍必须经 Input → InputManager → Flusher。
9. **Asset hook 写入必须 append-only**：不得重写历史 JSONL；增量状态（如 line record）必须独立存储。
10. **字段归一化必须保持可回放**：history JSONL 应包含足够上下文，方便重新跑 Input 逻辑验证 mapping。
