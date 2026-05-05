# 功能规格说明：Qoder CLI Agent

**功能分支**: `103-agent-qoder-cli`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Qoder CLI 通过 Hook 机制（PreToolUse / PostToolUse / Stop 事件）将遥测数据写入每日轮转的 JSONL 日志文件。本 Agent 包含两条数据采集通道：

1. **工具事件通道** — 从 PreToolUse / PostToolUse Hook JSONL 日志中采集文件操作事件
2. **会话转录通道** — 通过 Stop Hook 增量上传 Qoder CLI 会话转录（transcript）到 SLS

| 项目 | 工具事件通道 | 会话转录通道 |
|------|------------|------------|
| **采集基类** | `BaseHookInput`（Hook JSONL 日志采集） | Stop Hook 脚本（Python） |
| **数据目录** | `~/.loongsuite-pilot/logs/qoder-cli/history/` | `~/.qoder/projects/{slug}/transcript/{session}.jsonl` |
| **文件命名** | `qoder-cli-{YYYY-MM-DD}.jsonl` | 由 Qoder CLI 管理的会话文件 |
| **游标类型** | StateStore (byte offset) | 行号记录文件 (`.line_records.json`) |

### 数据流概览

```
Qoder CLI 会话
  │
  ├── PreToolUse Hook ──→ 注入 loongsuite_pilot_pre_file_exists 等字段
  │                        写入 JSONL 日志
  │
  ├── PostToolUse Hook ──→ 记录工具执行结果
  │                         写入同一 JSONL 日志
  │                         ↓
  │                    QoderCliInput (TypeScript)
  │                    byte offset 增量读取 → 归一化 → 输出
  │
  └── Stop Hook ─────────→ 读取 transcript JSONL
                            行号增量计算
                            批量上传到 SLS
```

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Qoder CLI Hook 日志（优先级：P1）

作为平台运维人员，我需要系统从 Qoder CLI 的 Hook JSONL 日志中采集 PostToolUse 事件，提取文件操作信息。

**优先级理由**: Hook 日志是 Qoder CLI 工具事件采集的核心数据来源。

**独立测试**: 可通过在日志目录下创建测试 JSONL 文件（含 PostToolUse 事件），验证系统正确过滤和归一化。

**验收场景**:

1. **Given** 日志文件中有一条 `event_type` 包含 `PostToolUse` 的记录，**When** 系统解析，**Then** 提取工具输入中的 `file_path` 并归一化为活动记录
2. **Given** 日志文件中有一条 `event_type` 不包含 `PostToolUse` 的记录（如 `PreToolUse`），**When** 系统过滤，**Then** 该记录被跳过
3. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `loongsuite_pilot_pre_file_exists` 为 `false`，**When** 系统分类，**Then** `actionType` 为 `Create`
4. **Given** 工具名为 `create_file` 或 `write_to_file` 且 `loongsuite_pilot_pre_file_exists` 为 `true`，**When** 系统分类，**Then** `actionType` 为 `Edit`（覆盖已存在的文件）
5. **Given** 工具输入中没有 `file_path` 也没有 `path`，**When** 系统检查，**Then** 该记录被跳过

---

### 用户故事 2 — Stop Hook 增量上传会话转录（优先级：P1）

作为平台运维人员，我需要在 Qoder CLI 会话结束时，自动将新增的转录内容上传到 SLS，支持增量传输以避免重复。

**优先级理由**: 会话转录包含完整的交互上下文（用户问题、AI 回答、工具调用），是分析 AI 使用模式的关键数据。

**独立测试**: 可通过构造测试 transcript JSONL 文件和 `.line_records.json`，验证增量范围计算、上传和行号记录更新。

**验收场景**:

1. **Given** transcript 文件有 100 行，上次记录的行号为 50，**When** Stop Hook 触发，**Then** 仅读取第 50-100 行并上传到 SLS，更新行号记录为 100
2. **Given** transcript 文件有 100 行，无历史行号记录（首次采集），**When** Stop Hook 触发，**Then** 读取全部 100 行并上传
3. **Given** transcript 文件的 `session_id` 与上次记录的不同（会话切换），**When** Stop Hook 计算增量范围，**Then** 重置行号为 0，重新上传全部内容
4. **Given** transcript 文件当前行数 < 上次记录行数（文件被截断），**When** Stop Hook 检测到截断，**Then** 重置行号为 0，从头上传
5. **Given** transcript 文件当前行数 = 上次记录行数（无新内容），**When** Stop Hook 检查，**Then** 跳过上传，不做任何操作
6. **Given** 上传成功，**When** Stop Hook 更新行号记录，**Then** `.line_records.json` 中记录新的 `last_line_count`、`session_id` 和 `updated_at`

---

### 用户故事 3 — Stop Hook 调用模式与递归防护（优先级：P1）

作为平台运维人员，我需要 Stop Hook 支持 CLI 参数和 stdin JSON 两种调用方式，并防止 Hook 触发无限递归。

**验收场景**:

1. **Given** Stop Hook 通过 CLI 参数调用 `--transcript <path> --session-id <id>`，**When** 脚本执行，**Then** 使用 CLI 参数作为输入
2. **Given** Stop Hook 通过 stdin 接收 JSON（含 `transcript_path` 和 `session_id`），**When** 脚本执行，**Then** 从 stdin JSON 中提取参数
3. **Given** stdin JSON 中 `stop_hooks_active` 为 `true`，**When** 脚本读取 stdin，**Then** 立即退出（exit 0），避免递归调用
4. **Given** CLI 参数和 stdin 均未提供 `transcript_path` 或 `session_id`，**When** 脚本执行，**Then** 静默退出（exit 0）

---

### 用户故事 4 — 数据序列化与 SLS 上传（优先级：P1）

作为平台运维人员，我需要转录数据在上传到 SLS 前正确序列化为键值对格式，长值截断以满足 SLS 字段限制。

**验收场景**:

1. **Given** 转录行解析为 JSON 对象，**When** 序列化为 SLS 格式，**Then** 每个顶层字段展平为 `(key, value)` 键值对
2. **Given** 某字段值为嵌套 `dict` 或 `list`，**When** 序列化，**Then** 使用 `json.dumps()` 转为 JSON 字符串
3. **Given** 某字段值长度超过 4096 字符，**When** 截断，**Then** 截取前 4096 字符并追加 `...[truncated]`
4. **Given** 某字段值为 `null` / `None`，**When** 序列化，**Then** 跳过该字段
5. **Given** 某字段值为布尔类型，**When** 序列化，**Then** 转为小写字符串（`"true"` / `"false"`）
6. **Given** 原始数据有 `sessionId` 但没有 `session_id`，**When** 序列化，**Then** 额外追加 `session_id` 键值对（字段名归一化）
7. **Given** 每条日志，**When** 上传，**Then** 附加 `log_source=transcript` 标签和 `__hostname__` 机器标识

---

### 用户故事 5 — Qoder CLI 可用性检测（优先级：P2）

**验收场景**:

1. **Given** `~/.qoder` 目录存在，**When** 调用 `checkAvailability()`，**Then** 返回 `true`

---

### 边界用例

- `tool_input` 字段缺失时，跳过记录
- `tool_input.content` 和 `tool_input.new_string` 均缺失时，`content` 为空字符串
- `tool_response` 可作为 `diff` 的降级来源
- 转录行不是合法 JSON 时，跳过该行继续处理
- `.line_records.json` 文件损坏或不可读时，降级为空记录（从头采集）
- 多个 Stop Hook 实例并发写入 `.line_records.json` 时，通过文件锁（`fcntl.flock`）保证安全
- transcript 文件在上传过程中被追加写入时，仅处理 `get_line_range()` 时刻确定的行数

---

## 需求 *(必填)*

### 功能需求

**工具事件通道（TypeScript QoderCliInput）**

- **FR-001**: `QoderCliInput` 必须继承 `BaseHookInput`，实现 `transformRecord()` 方法
- **FR-002**: `transformRecord()` 必须仅处理 `event_type` 包含 `PostToolUse` 的记录
- **FR-003**: 必须利用 `loongsuite_pilot_pre_file_exists` 字段区分 `Create`（新建）和 `Edit`（覆盖）操作
- **FR-004**: 工具输入中无 `file_path`、`path`、`filepath` 的记录必须被跳过
- **FR-005**: 归一化必须调用 `buildAgentActivityEntry()`，`agentType` 为 `ClientType.QoderCliHook`

**会话转录通道（Python Stop Hook）**

- **FR-006**: Stop Hook 必须支持 CLI 参数模式（`--transcript`、`--session-id`）和 stdin JSON 模式双入口
- **FR-007**: stdin 模式必须检查 `stop_hooks_active` 字段，为 `true` 时立即退出以防递归
- **FR-008**: 增量行号追踪必须使用 `.line_records.json` 文件持久化，结构为 `{transcript_path: {session_id, last_line_count, updated_at}}`
- **FR-009**: 会话 ID 变更时必须重置行号为 0，重新上传全部转录内容
- **FR-010**: 文件截断（当前行数 < 记录行数）时必须重置行号为 0
- **FR-011**: 数据序列化必须将 JSON 字段展平为键值对，嵌套对象序列化为 JSON 字符串，单字段最大长度 4096 字符
- **FR-012**: 批量上传到 SLS，每条日志附带 `log_source=transcript` 和 `__hostname__` 标签
- **FR-013**: `.line_records.json` 的读写必须使用文件锁（读取用共享锁，写入用排他锁）

### 关键实体

- **QoderCliInput**: 继承 `BaseHookInput` 的具体输入源，ID 为 `'qoder-cli-hook'`，处理工具事件通道
- **qoder_hook.py**: Stop Hook 数据上传脚本，处理会话转录通道
- **.line_records.json**: 行号追踪持久化文件，键为 transcript 文件路径，值为 `{session_id, last_line_count, updated_at}`

### 数据序列化规则

| 源类型 | 序列化方式 |
|--------|----------|
| `str` | 原值截断至 4096 字符 |
| `bool` | 小写字符串 `"true"` / `"false"` |
| `dict` / `list` | `json.dumps()` 后截断至 4096 字符 |
| `None` | 跳过，不写入 |
| `int` / `float` | `str()` 转换 |

---

## 成功标准 *(必填)*

- **SC-001**: PostToolUse 事件的过滤准确率 100%
- **SC-002**: Create vs Edit 的分类基于 `loongsuite_pilot_pre_file_exists` 的准确率 100%
- **SC-003**: 面对缺失字段或非标准事件，100% 不崩溃
- **SC-004**: Stop Hook 增量行号追踪准确率 100%（无重复上传、无遗漏）
- **SC-005**: 会话切换和文件截断场景下自动重置，数据完整性 100%
- **SC-006**: 并发 Stop Hook 实例不会导致 `.line_records.json` 损坏

---

## 假设

- Hook 脚本由平台自身安装和维护，JSONL 格式可控
- `loongsuite_pilot_pre_file_exists` 字段由 PreToolUse Hook 注入，在 PostToolUse 事件中始终可用
- 日志目录由 `BaseHookInput.onStart()` 自动创建
- Stop Hook 运行环境已安装 `aliyun-log-python-sdk`
- SLS 配置（endpoint、access_key_id、access_key、project、logstore）由安装脚本写入 Stop Hook 脚本
- transcript JSONL 文件由 Qoder CLI 本身管理，每行为一个合法 JSON 对象
- 单次 Stop Hook 调用的上传量不会超出 SLS 单次写入限制
