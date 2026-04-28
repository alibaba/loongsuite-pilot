# 功能规格说明：Qoder Work Agent

**功能分支**: `102-agent-qoder-work`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Qoder Work 是一款 AI 编程代理工具（agentic coding），通过终端交互。本 Agent 通过 Hook 机制（PreToolUse / PostToolUse 事件）采集工具执行数据，复用 Qoder CLI 的 Hook 脚本（`aac-qoder-hook.sh`），以 `qoder-work` 作为 agent ID 参数写入独立日志目录。

| 项目 | 值 |
|------|---|
| **采集基类** | `BaseHookInput`（Hook JSONL 日志采集） |
| **Hook 配置** | `~/.qoderwork/settings.json` |
| **Hook 脚本** | `aac-qoder-hook.sh qoder-work`（复用 Qoder CLI 脚本） |
| **数据目录** | `~/.ai-agent-collector/logs/qoder-work/history/` |
| **文件命名** | `qoder-work-{YYYY-MM-DD}.jsonl` |
| **游标类型** | StateStore (byte offset) |

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Qoder Work Hook 日志（优先级：P1）

作为平台运维人员，我需要系统从 Qoder Work 的 Hook JSONL 日志中采集 PostToolUse 事件，提取文件操作信息。

**优先级理由**: Hook 日志是 Qoder Work 采集的核心数据来源。

**独立测试**: 可通过在日志目录下创建测试 JSONL 文件（含 PostToolUse 事件），验证系统正确过滤和归一化。

**验收场景**:

1. **Given** 日志文件中有一条 `event_type` 包含 `PostToolUse` 的记录，**When** 系统解析，**Then** 提取工具输入中的 `file_path` 并归一化为活动记录
2. **Given** 日志文件中有一条 `event_type` 不包含 `PostToolUse` 的记录（如 `PreToolUse`），**When** 系统过滤，**Then** 该记录被跳过
3. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `aac_pre_file_exists` 为 `false`，**When** 系统分类，**Then** `actionType` 为 `Create`
4. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `aac_pre_file_exists` 为 `true`，**When** 系统分类，**Then** `actionType` 为 `Edit`（覆盖已存在的文件）
5. **Given** 工具输入中没有 `file_path` 也没有 `path`，**When** 系统检查，**Then** 该记录被跳过

---

### 用户故事 2 — Qoder Work 可用性检测（优先级：P2）

作为核心编排层，我需要能够检测 Qoder Work 是否已安装。

**验收场景**:

1. **Given** `~/.qoderwork` 目录存在，**When** 调用 `checkAvailability()`，**Then** 返回 `true`

---

### 边界用例

- `tool_input` 字段缺失时，跳过记录
- `tool_input.content` 和 `tool_input.new_string` 均缺失时，`content` 为空字符串
- `tool_response` 可作为 `diff` 的降级来源

---

## 需求 *(必填)*

### 功能需求

- **FR-001**: `QoderWorkInput` 必须继承 `BaseHookInput`，实现 `transformRecord()` 方法
- **FR-002**: `transformRecord()` 必须仅处理 `event_type` 包含 `PostToolUse` 的记录
- **FR-003**: 必须利用 `aac_pre_file_exists` 字段区分 `Create`（新建）和 `Edit`（覆盖）操作
- **FR-004**: 工具输入中无 `file_path`、`path`、`filepath` 的记录必须被跳过
- **FR-005**: 归一化必须调用 `buildAgentActivityEntry()`，`agentType` 为 `ClientType.QoderWork`
- **FR-006**: Hook 脚本通过 `HookManager.buildQoderWorkHooks()` 安装到 `~/.qoderwork/settings.json`，复用 `aac-qoder-hook.sh` 并传递 `qoder-work` 作为 agent ID

### 关键实体

- **QoderWorkInput**: 继承 `BaseHookInput` 的具体输入源，ID 为 `'qoder-work-hook'`

---

## 成功标准 *(必填)*

- **SC-001**: PostToolUse 事件的过滤准确率 100%
- **SC-002**: Create vs Edit 的分类基于 `aac_pre_file_exists` 的准确率 100%
- **SC-003**: 面对缺失字段或非标准事件，100% 不崩溃

---

## 假设

- Hook 脚本由平台自身安装和维护，JSONL 格式可控
- `aac_pre_file_exists` 字段由 PreToolUse Hook 注入，在 PostToolUse 事件中始终可用
- 日志目录由 `BaseHookInput.onStart()` 自动创建
- QoderWork 与 Qoder CLI 使用相同的 Hook 脚本，通过 agent ID 参数区分日志目录
