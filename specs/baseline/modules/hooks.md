# Module: hooks

> Last verified: 2026-05-13

## 职责 (Responsibility)

Hook 脚本管理层，负责将数据采集 hook 脚本注入到各 AI coding agent 的配置文件中，使其在关键事件时触发数据上报。

## 公共接口 (Public Interface)

- **HookDefinition** — Hook 定义接口，描述一个 agent hook 的完整信息：目标 agent 标识、settings 文件路径、JSON 导航路径、hook 命令、匹配器以及格式标志。
- **HookManager** — Hook 脚本管理器，提供 hook 的安装、卸载和安装状态检查能力。同时通过静态工厂方法为已知 agent（Cursor、Qoder CLI、QoderWork）生成预定义的 HookDefinition 列表，也提供通用模板用于快速接入新 agent。

## 内部设计 (Internal Design)

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

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| utils | `readJsonFile`, `writeJsonFile`, `ensureDir`, `resolveHome`, `fileExists`, `createLogger` |
| node:fs/promises | 文件操作 |
| node:path | 路径构造 |

## 扩展指南 (Extension Guide)

### 为新 Agent 添加 Hook 支持

新增 Agent hook 需要实现一个静态工厂方法返回 HookDefinition 数组，指定 agent 的 settings 路径、hook 命令和格式。参考现有实现: [src/hooks/hook-manager.ts](../../src/hooks/hook-manager.ts)

步骤概要：
1. 确定 agent 的 settings 文件路径和格式（通常为 `~/.agent-name/settings.json`）
2. 在 HookManager 中添加静态工厂方法
3. 创建 hook shell 脚本 `assets/hooks/my-agent-hook.sh`，调用 `hook-processor.mjs`
4. 在 `Orchestrator.installHooks()` 中调用
5. 在 `postinstall.js` 中部署 hook 脚本到 `~/.loongsuite-pilot/hooks/`

## 约束 (Constraints)

1. **Hook 安装为幂等操作**：重复安装不应产生重复条目。
2. **Settings 文件写入必须保持原有内容不变**：仅追加/删除 hook 相关条目。
3. **安装失败不得中断主流程**：返回 false 而非抛出异常。
4. **hook shell 脚本必须为可执行文件**：postinstall 时设置 chmod +x。
5. **hookJsonPath 深度无限制但须为有效 JSON path**：每个 segment 为对象 key。
6. **buildGenericHook 为通用模板**：仅适用于支持 PostToolUse 事件的 MCP-compatible 工具。
