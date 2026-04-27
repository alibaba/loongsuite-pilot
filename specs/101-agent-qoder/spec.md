# 功能规格说明：Qoder IDE Agent

**功能分支**: `101-agent-qoder`
**创建日期**: 2026-04-27
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

Qoder IDE 是一款基于 VS Code 架构的 AI 编程助手。本 Agent 从三个独立数据源采集使用数据：

| 数据源 | 采集基类 | 数据格式 | 游标类型 |
|--------|---------|---------|---------|
| `User/History/` — 文件编辑历史 | BaseIdeInput | VS Code entries.json | SnapshotStore (key 去重) |
| `SharedClientCache/cache/db/local.db` — 对话记录 | BaseIdeInput (内嵌 SQLite) | SQLite chat_record + chat_session | StateStore (rowid) |
| `SharedClientCache/cache/ai_tracker/*.jsonl` — AI 追踪 | BaseIdeInput (内嵌 JSONL) | JSONL 文件 | StateStore (byte offset) |

**数据目录**:
- macOS: `~/Library/Application Support/Qoder/`
- Linux: `~/.config/Qoder/` (或 `$XDG_CONFIG_HOME/Qoder/`)

---

## 用户场景与测试 *(必填)*

### 用户故事 1 — 采集 Qoder IDE 文件编辑历史（优先级：P1）

作为平台运维人员，我需要系统从 Qoder IDE 的 VS Code 风格文件编辑历史中，提取 AI 生成的代码编辑事件。

**优先级理由**: 文件编辑历史是 Qoder IDE 最核心的 AI 使用数据来源。

**独立测试**: 可通过在 `User/History/{dir}/entries.json` 中构造包含 AI source 标记的编辑记录，验证系统正确识别并归一化为活动记录。

**验收场景**:

1. **Given** `User/History/` 目录下有多个子目录，每个含有 `entries.json`，**When** 系统执行扫描，**Then** 逐一解析每个 `entries.json`，提取 `resource` 和 `entries` 数组
2. **Given** `entries.json` 中某条记录的 `source` 字段匹配 AI 关键词（`qoder`、`ai`、`agent`、`copilot`、`assistant`、`completion`），**When** 系统过滤，**Then** 该记录被识别为 AI 生成的编辑事件
3. **Given** `entries.json` 中某条记录没有 `source` 字段或 `source` 不匹配 AI 关键词，**When** 系统过滤，**Then** 该记录被跳过
4. **Given** 上次扫描的高水位线为时间戳 T，**When** 系统扫描，**Then** 仅处理 `timestamp >= T` 的记录
5. **Given** `History` 目录不存在，**When** 系统扫描，**Then** 安全返回空结果，不报错

---

### 用户故事 2 — 采集 Qoder IDE 对话记录（优先级：P1）

作为平台运维人员，我需要系统从 Qoder IDE 的 SQLite 数据库中采集 AI 对话记录（chat_record + chat_session），包括用户问题、AI 回答和会话上下文。

**优先级理由**: 对话记录是理解用户如何与 AI 交互的关键数据。

**独立测试**: 可通过构造一个包含 `chat_record` 和 `chat_session` 表的测试 SQLite 数据库，验证系统正确读取并归一化。

**验收场景**:

1. **Given** `SharedClientCache/cache/db/local.db` 存在，**When** 系统查询 `chat_record` 表（`WHERE rowid > lastRowId`），**Then** 获取增量对话记录并关联 `chat_session` 的 `session_title` 和 `project_name`
2. **Given** 上次采集到 rowid=100，**When** 系统查询，**Then** 仅返回 `rowid > 100` 的记录，limit 500
3. **Given** 对话记录包含 `question` 和 `answer`，**When** 系统归一化，**Then** `answer` 截取前 2000 字符作为 `content`，`question` 截取前 2000 字符存入 `extra`
4. **Given** 数据库文件不存在或无法打开，**When** 系统尝试扫描，**Then** 记录警告并跳过，不影响其他数据源

---

### 用户故事 3 — 采集 Qoder IDE AI 追踪日志（优先级：P2）

作为平台运维人员，我需要系统从 Qoder IDE 的 `ai_tracker` JSONL 文件中采集详细的 AI 代码修改追踪数据。

**优先级理由**: AI 追踪日志包含精确的代码增删行信息，是分析 AI 代码贡献量的重要数据源。

**独立测试**: 可通过在 `ai_tracker/` 目录下创建测试 JSONL 文件，验证系统正确读取并基于 byte offset 增量采集。

**验收场景**:

1. **Given** `SharedClientCache/cache/ai_tracker/` 目录下有 `.jsonl` 文件，**When** 系统扫描，**Then** 对每个文件基于 byte offset 增量读取新增内容
2. **Given** JSONL 行中包含 `filePath`、`aiAddedLines`、`aiDeletedLines`、`aiModifiedContent`，**When** 系统解析，**Then** 归一化为 `actionType=Edit` 的活动记录，`content` 截取前 2000 字符
3. **Given** 某个追踪文件上次读到 offset=512，文件当前大小为 1024，**When** 系统读取，**Then** 仅读取 offset 512-1024 之间的新增内容
4. **Given** `ai_tracker` 目录不存在，**When** 系统扫描，**Then** 安全返回，不报错

---

### 用户故事 4 — Qoder IDE 可用性检测与 Agent 发现（优先级：P2）

作为核心编排层，我需要能够检测 Qoder IDE 是否已安装，并获取需要监听的文件系统路径。

**验收场景**:

1. **Given** Qoder IDE 的数据目录存在，**When** 调用 `QoderInput.checkAvailability()`，**Then** 返回 `true`
2. **Given** 调用 `QoderInput.getWatchPaths()`，**Then** 返回包含数据根目录及其父目录的路径列表

---

### 边界用例

- `entries.json` 格式损坏（非法 JSON）时，跳过该目录继续处理
- `entries.json` 缺少 `resource` 或 `entries` 字段时，跳过
- SQLite 数据库被其他进程锁定时，记录警告并在下一周期重试
- `ai_tracker` 中包含空行或畸形 JSON 时，跳过该行继续
- `ai_tracker` 中包含非 `.jsonl` 文件时，忽略

---

## 需求 *(必填)*

### 功能需求

- **FR-001**: `QoderInput` 必须继承 `BaseIdeInput`，实现 `scanHistoryEntries()` 和 `buildEntry()` 方法
- **FR-002**: `scanHistoryEntries()` 必须串行扫描三个数据源（fileHistory → chatRecords → aiTracker）
- **FR-003**: 文件编辑历史扫描必须过滤非 AI 来源的记录，过滤关键词包括 `qoder`、`ai`、`agent`、`copilot`、`assistant`、`completion`
- **FR-004**: 对话记录采集必须通过 SQLite 的 `rowid > lastRowId` 实现增量，每次最多 500 条
- **FR-005**: AI 追踪日志采集必须通过 StateStore 的 byte offset 实现增量读取
- **FR-006**: 所有数据源的归一化必须调用 `buildAgentActivityEntry()`，`agentType` 统一为 `ClientType.Qoder`
- **FR-007**: 必须提供 `checkAvailability()` 静态方法检测 Agent 安装状态
- **FR-008**: 必须提供 `getWatchPaths()` 静态方法返回需要监听的文件路径

### 关键实体

- **QoderInput**: 继承 `BaseIdeInput` 的具体输入源，ID 为 `'qoder'`，管理三个独立数据源的扫描逻辑
- **fileHistory 扫描**: 遍历 `User/History/*/entries.json`，过滤 AI 来源
- **chatRecords 扫描**: 查询 SQLite `chat_record JOIN chat_session`，基于 rowid 增量
- **aiTracker 扫描**: 遍历 `ai_tracker/*.jsonl`，基于 byte offset 增量

---

## 成功标准 *(必填)*

- **SC-001**: Qoder IDE 数据目录存在时，系统能在 60 秒内完成首次数据采集
- **SC-002**: 三个数据源的增量采集准确率均为 100%
- **SC-003**: 对话记录的 `answer` 和 `question` 截取不超过 2000 字符
- **SC-004**: 面对缺失的数据目录或损坏的数据文件，100% 不崩溃

---

## 假设

- Qoder IDE 基于 VS Code 架构，`User/History/` 目录结构稳定
- SQLite 数据库的 `chat_record` 和 `chat_session` 表 schema 在同一大版本内不变
- `ai_tracker` JSONL 格式在同一大版本内保持稳定
- Qoder IDE 的数据目录位于用户目录下的标准位置
