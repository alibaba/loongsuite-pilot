# 功能规格说明：Qoder CLI Agent

**功能分支**: `103-agent-qoder-cli`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Qoder CLI 通过 Hook 机制（PreToolUse / PostToolUse / failure 事件）将遥测数据写入每日轮转的 JSONL 日志文件。本 Agent 从这些日志中采集文件操作事件。

| 项目 | 值 |
|------|---|
| **采集基类** | `BaseHookInput`（Hook JSONL 日志采集） |
| **数据目录** | `~/.ai-agent-collector/logs/qoder-cli/history/` |
| **文件命名** | `qoder-cli-{YYYY-MM-DD}.jsonl` |
| **游标类型** | StateStore (byte offset) |

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Qoder CLI Hook 日志（优先级：P1）

作为平台运维人员，我需要系统从 Qoder CLI 的 Hook JSONL 日志中采集 PostToolUse 事件，提取文件操作信息。

**优先级理由**: Hook 日志是 Qoder CLI 采集的唯一数据来源。

**独立测试**: 可通过在日志目录下创建测试 JSONL 文件（含 PostToolUse 事件），验证系统正确过滤和归一化。

**验收场景**:

1. **Given** 日志文件中有一条 `event_type` 包含 `PostToolUse` 的记录，**When** 系统解析，**Then** 提取工具输入中的 `file_path` 并归一化为活动记录
2. **Given** 日志文件中有一条 `event_type` 不包含 `PostToolUse` 的记录（如 `PreToolUse`），**When** 系统过滤，**Then** 该记录被跳过
3. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `aac_pre_file_exists` 为 `false`，**When** 系统分类，**Then** `actionType` 为 `Create`
4. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `aac_pre_file_exists` 为 `true`，**When** 系统分类，**Then** `actionType` 为 `Edit`（覆盖已存在的文件）
5. **Given** 工具输入中没有 `file_path` 也没有 `path`，**When** 系统检查，**Then** 该记录被跳过

---

### 用户故事 2 — Qoder CLI 可用性检测（优先级：P2）

**验收场景**:

1. **Given** `~/.qoder` 目录存在，**When** 调用 `checkAvailability()`，**Then** 返回 `true`

---

### 边界用例

- `tool_input` 字段缺失时，跳过记录
- `tool_input.content` 和 `tool_input.new_string` 均缺失时，`content` 为空字符串
- `tool_response` 可作为 `diff` 的降级来源

---

## 需求 *(必填)*

### 功能需求

- **FR-001**: `QoderCliInput` 必须继承 `BaseHookInput`，实现 `transformRecord()` 方法
- **FR-002**: `transformRecord()` 必须仅处理 `event_type` 包含 `PostToolUse` 的记录
- **FR-003**: 必须利用 `aac_pre_file_exists` 字段区分 `Create`（新建）和 `Edit`（覆盖）操作
- **FR-004**: 工具输入中无 `file_path` 和 `path` 的记录必须被跳过
- **FR-005**: 归一化必须调用 `buildAgentActivityEntry()`，`agentType` 为 `ClientType.QoderCliHook`

### 关键实体

- **QoderCliInput**: 继承 `BaseHookInput` 的具体输入源，ID 为 `'qoder-cli-hook'`

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
