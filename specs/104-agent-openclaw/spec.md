# 功能规格说明：Openclaw Agent

**功能分支**: `104-agent-openclaw`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Openclaw 是一款新兴的 AI 编程代理。本 Agent 通过会话文件轮询采集数据，演示了如何为平台接入一个全新的 Agent。

| 项目 | 值 |
|------|---|
| **采集基类** | `BaseSessionInput`（会话文件轮询） |
| **数据目录** | `~/.openclaw/sessions/` |
| **文件命名** | `session-*.jsonl`（支持子目录） |
| **游标类型** | StateStore (byte offset + inode) |

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Openclaw 会话数据（优先级：P1）

作为平台运维人员，我需要系统从 Openclaw 的 JSONL 会话文件中采集文件修改类的工具调用事件。

**优先级理由**: 文件修改是 AI 编程代理最核心的活动数据。

**独立测试**: 可通过构造测试 JSONL 会话文件（含 `session_meta` 和 `tool_call` 记录），验证系统正确过滤和归一化。

**验收场景**:

1. **Given** 会话文件中有一条 `type=session_meta` 的记录，**When** 系统解析，**Then** 提取 `session_id`、`model`、`cwd` 作为后续记录的上下文，不产出活动记录
2. **Given** 会话文件中有一条 `type=tool_call` 的记录，且 `tool_name` 属于文件修改工具集，**When** 系统解析，**Then** 归一化为活动记录
3. **Given** 文件修改工具集为 `write_file`、`create_file`、`edit_file`、`replace_in_file`、`apply_patch`、`insert_text`、`delete_file`，**When** `tool_name` 不在此集合中，**Then** 该记录被跳过
4. **Given** `tool_call` 记录中 `file_path` 为空，**When** 系统检查，**Then** 该记录被跳过

---

### 用户故事 2 — Openclaw 工具调用分类（优先级：P1）

**验收场景**:

| tool_name | 分类 ActionType |
|-----------|----------------|
| `create_file` / `write_file` | Create |
| `delete_file` | Delete |
| 其他文件修改工具 | Edit |

---

### 用户故事 3 — 会话文件发现（优先级：P2）

作为平台运维人员，我需要系统能够递归发现 `~/.openclaw/sessions/` 下的所有会话文件，包括子目录中的。

**验收场景**:

1. **Given** sessions 目录下同时有直接的 `session-*.jsonl` 文件和子目录中的 `session-*.jsonl` 文件，**When** 系统发现文件，**Then** 两层都被包含
2. **Given** sessions 目录不存在，**When** 系统发现文件，**Then** 返回空列表，不报错

---

### 用户故事 4 — Openclaw 可用性检测（优先级：P2）

**验收场景**:

1. **Given** `~/.openclaw` 目录存在，**When** 调用 `checkAvailability()`，**Then** 返回 `true`

---

### 边界用例

- `type` 既不是 `session_meta` 也不是 `tool_call` 时，跳过
- `session_meta` 缺少 `session_id` 时，使用空字符串
- 在没有前置 `session_meta` 的情况下遇到 `tool_call`，使用记录自带的 `session_id`

---

## 需求 *(必填)*

### 功能需求

- **FR-001**: `OpenclawInput` 必须继承 `BaseSessionInput`，实现 `discoverSessionFiles()` 和 `processSessionLine()`
- **FR-002**: `discoverSessionFiles()` 必须支持两层目录发现（顶层 + 一级子目录）
- **FR-003**: `processSessionLine()` 必须维护 per-file 的 `SessionMeta` 上下文映射，从 `session_meta` 记录中提取并用于后续 `tool_call` 记录
- **FR-004**: 仅处理 `type=tool_call` 且 `tool_name` 属于文件修改工具集的记录
- **FR-005**: 归一化必须调用 `buildAgentActivityEntry()`，`agentType` 为 `ClientType.Openclaw`

### 关键实体

- **OpenclawInput**: 继承 `BaseSessionInput` 的具体输入源，ID 为 `'openclaw'`
- **SessionMeta**: per-file 的上下文缓存，包含 `sessionId`、`model`、`cwd`

---

## 成功标准 *(必填)*

- **SC-001**: 文件修改工具集的过滤准确率 100%
- **SC-002**: `session_meta` 上下文正确关联到后续 `tool_call` 记录
- **SC-003**: 两层目录发现覆盖所有会话文件
- **SC-004**: 面对缺失字段或未知记录类型，100% 不崩溃

---

## 假设

- Openclaw 的会话文件目录位于 `~/.openclaw/sessions/`
- 文件修改工具集在同一大版本内保持稳定
- 每个会话文件的第一条记录通常是 `session_meta`（但不保证）
