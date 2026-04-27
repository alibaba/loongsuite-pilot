# 功能规格说明：Qoder Work Agent

**功能分支**: `102-agent-qoder-work`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Qoder Work 是一款 AI 编程代理工具（agentic coding），通过终端交互。本 Agent 从两个数据目录采集 JSONL 会话文件：

| 数据目录 | 说明 |
|---------|------|
| `~/Library/Application Support/QoderWork/cli/projects/{slug}/{session}.jsonl` | QoderWork 桌面应用 |
| `~/.qoder/projects/{slug}/transcript/{session}.jsonl` | Qoder CLI 会话文件 |

**采集基类**: `BaseSessionInput`（会话文件轮询，byte offset + inode 检测）

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Qoder Work 会话文件（优先级：P1）

作为平台运维人员，我需要系统从 Qoder Work 的 JSONL 会话文件中采集 AI 编程活动，包括对话内容、工具调用和会话元数据。

**优先级理由**: Qoder Work 是重要的 AI 编程代理，其会话数据包含丰富的工具使用和代码生成信息。

**独立测试**: 可通过构造测试 JSONL 会话文件（含 `assistant`、`tool_use`、`session_meta` 等消息类型），验证系统正确分类和归一化。

**验收场景**:

1. **Given** QoderWork 项目目录或 Qoder CLI 项目目录下有 `.jsonl` 文件，**When** 系统发现会话文件，**Then** 同时扫描两个数据目录并去重
2. **Given** JSONL 行的 `type` 为 `assistant` 且 `message.content` 为字符串，**When** 系统解析，**Then** 归一化为 `actionType=Other` 的活动记录，`content` 截取前 2000 字符
3. **Given** JSONL 行的 `type` 为 `assistant` 且 `message.content` 为数组，含有 `tool_use` block，**When** 系统解析，**Then** 提取工具名和输入参数，通过 `classifyToolCall()` 分类操作类型
4. **Given** JSONL 行的 `type` 为 `session_meta` 或 `progress`，**When** 系统解析，**Then** 归一化为 `actionType=Other`，`data` 序列化为 `content`

---

### 用户故事 2 — 工具调用分类（优先级：P1）

作为数据分析人员，我需要系统能够正确分类 AI Agent 使用的各种工具，以便按操作类型统计和分析。

**验收场景**:

| 工具名 | 分类 ActionType | 提取字段 |
|--------|----------------|---------|
| `create_file` / `Write` | Create | file_path/path → filePath, content |
| `search_replace` / `Edit` | Edit | file_path/path → filePath, new_string/new_str → content |
| `delete_file` | Delete | file_path/path → filePath |
| `run_in_terminal` / `Bash` | Execute | cwd → filePath, command → content |
| `read_file` / `Read` | Read | file_path/path → filePath |
| `search_file` / `Glob` / `grep_code` / `Grep` / `search_codebase` | Search | path/directory → filePath, pattern/query/regex → content |
| `fetch_content` / `WebFetch` / `search_web` / `WebSearch` | Browse | url/query/search_term → content |
| 其他 | Other | input JSON → content (截取 500 字符) |

---

### 用户故事 3 — Qoder Work 可用性检测（优先级：P2）

作为核心编排层，我需要能够检测 Qoder Work 是否已安装。

**验收场景**:

1. **Given** 以下任一目录存在：QoderWork 项目目录、`~/.qoder/projects`、`~/.qoder/cache/experts`，**When** 调用 `checkAvailability()`，**Then** 返回 `true`

---

### 边界用例

- JSONL 行的 `type` 不是已知类型时，返回 `null` 跳过
- `message` 字段缺失时，返回 `null`
- `content` 数组中的 `tool_result` block 应归一化为 `actionType=Other`
- `content` 数组中的 `text` block 应归一化为 `actionType=Other`
- 工具调用输入中缺少 `file_path` 时，降级使用 `cwd`

---

## 需求 *(必填)*

### 功能需求

- **FR-001**: `QoderWorkInput` 必须继承 `BaseSessionInput`，实现 `discoverSessionFiles()` 和 `processSessionLine()`
- **FR-002**: `discoverSessionFiles()` 必须扫描 QoderWork 桌面应用目录和 Qoder CLI 项目目录两个来源
- **FR-003**: `processSessionLine()` 必须正确处理 `assistant`、`user`、`session_meta`、`progress` 四种消息类型
- **FR-004**: 对于含有工具调用的消息，必须通过 `classifyToolCall()` 正确分类至少 8 种操作类型
- **FR-005**: 归一化必须调用 `buildAgentActivityEntry()`，`agentType` 为 `ClientType.QoderWork`

### 关键实体

- **QoderWorkInput**: 继承 `BaseSessionInput` 的具体输入源，ID 为 `'qoder-work'`
- **classifyToolCall**: 工具调用分类器，将工具名映射为 `ActionType` 并提取 `filePath` 和 `content`

---

## 成功标准 *(必填)*

- **SC-001**: 工具调用分类的准确率 100%（覆盖所有已知工具名）
- **SC-002**: 两个数据目录的会话文件均能被发现和处理
- **SC-003**: 面对未知消息类型或缺失字段，100% 不崩溃

---

## 假设

- QoderWork 桌面应用和 Qoder CLI 的 JSONL 格式兼容
- 会话文件的消息类型在同一大版本内保持稳定
- `tool_use` block 的 `name` 和 `input` 结构遵循固定 schema
