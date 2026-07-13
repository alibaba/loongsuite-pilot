# SQLite 数据采集诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/sqlite-diagnostics.md`，随 pilot 升级自动更新。

覆盖 **pilot 通过 SQLite 轮询采集数据的通用链路排查**。
大多数 SQLite Input 共享 `BaseSqliteInput` 的 `rowid` 增量机制；Qoder Work / Qoder Work CN 使用 `updated_at` 时间游标，但 DB 可访问性、表结构、游标状态与服务消费排查流程一致。
Qoder for JetBrains 的 token 数据位于 `~/.qoder/shared_client/cache/db/local.db`，由 `qoder-trace` 读取并标记为 `qoder-idea`，不单独注册 `*-sqlite` Input。

---

## 通用采集机制

```
目标应用运行时写入 SQLite DB
    ↓ 目标表产生新行
BaseSqliteInput 定时轮询（默认 30s）
    ↓ SELECT ... WHERE rowid > lastRowId（READONLY 模式打开）
具体 Input 子类.transformRow()
    ↓ 解析行数据 → 构建 AgentActivityEntry
Flusher → SLS / JSONL / HTTP
```

关键事实：
- Qoder / Qoder CN 以 SQLite 内置 `rowid` 为增量游标，只读新增行
- Qoder Work / Qoder Work CN 以 `messages.updated_at` 为增量游标，只读新增消息
- DB 以 `OPEN_READONLY` 打开，**不会影响**目标应用的正常读写
- 首次启动时自动取当前最大游标作为基线，**只采启动后新产生的数据**
- 每行独立处理——单行 transform 失败不影响其余行（跳过并 warn）
- 游标持久化在 `~/.loongsuite-pilot/logs/input-state.json` 中，以 Input ID 为 key

---

## SQLite Input 注册表

下表列出所有基于 SQLite 的 Input。排查时**先确认用户遇到问题的 Input**，再根据对应参数代入后续步骤。

| Input ID | agentType | 目标应用 | DB 路径（macOS） | DB 路径（Linux） | 目标表 | 关键列 | 过滤条件 |
|----------|-----------|---------|-----------------|-----------------|-------|-------|---------|
| `qoder-sqlite` | `qoder` | Qoder IDE | `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` | `${XDG_CONFIG_HOME:-~/.config}/Qoder/SharedClientCache/cache/db/local.db` | `chat_message` | `token_info`（JSON） | `token_info IS NOT NULL AND token_info != '' AND json_valid(token_info)` |
| `qoder-cn-sqlite` | `qoder-cn` | Qoder CN | `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db` | `${XDG_CONFIG_HOME:-~/.config}/QoderCN/SharedClientCache/cache/db/local.db` | `chat_message` | `token_info`（JSON） | `token_info IS NOT NULL AND token_info != '' AND json_valid(token_info)` |
| `qoder-work-sqlite` | `qoder-work` | Qoder Work | `~/Library/Application Support/QoderWork/data/agents.db` | `${XDG_CONFIG_HOME:-~/.config}/QoderWork/data/agents.db` | `messages` + `sub_chats` | `updated_at` / `parts` | `m.updated_at > <cursor> AND m.parts IS NOT NULL AND m.parts != '' AND m.parts != '[]'` |
| `qoder-work-cn-sqlite` | `qoder-work-cn` | Qoder Work CN | `~/Library/Application Support/QoderWork CN/data/agents.db` | `${XDG_CONFIG_HOME:-~/.config}/QoderWork CN/data/agents.db` | `messages` + `sub_chats` | `updated_at` / `parts` | `m.updated_at > <cursor> AND m.parts IS NOT NULL AND m.parts != '' AND m.parts != '[]'` |

> `qoder-work-sqlite` / `qoder-work-cn-sqlite` 使用 `input-state.json` 的 `extra.lastUpdatedAt` 作为时间游标，不使用 SQLite `rowid`。后续新增 SQLite Input 时，在此表追加一行即可，排查流程不变。

---

## 系统化排查顺序

SQLite 数据采集异常时，**按以下顺序逐步排查**。
以下步骤中用 `<INPUT_ID>` 代指具体 Input ID（如 `qoder-sqlite`），`<DB>` 代指对应的 DB 路径，`<TABLE>` 代指目标表名——均可从上方注册表查得。

```
第 1 步 → DB 文件是否存在且可访问
第 2 步 → 表结构与数据验证
第 3 步 → 游标状态检查
第 4 步 → pilot 是否成功消费
第 5 步 → 配置与环境检查
```

---

## 第 1 步：DB 文件是否存在且可访问

从注册表中获取对应平台的 DB 路径，检查文件是否存在：

```bash
# 将 <DB> 替换为注册表中的实际路径
DB="<DB>"
ls -la "$DB"
```

DB 文件不存在的常见原因：
- **目标应用从未启动过**（目录整体不存在）
- **目标应用版本过低**（旧版本不使用该 DB 结构）→ 升级到最新稳定版
- **Linux 上 `XDG_CONFIG_HOME` 自定义**导致路径不匹配 → 见第 5 步

---

## 第 2 步：表结构与数据验证

### 2.1 验证目标表和关键列存在

```bash
# 将 <TABLE> 和 <KEY_COLUMN> 替换为注册表中的值
sqlite3 "$DB" ".schema <TABLE>" 2>/dev/null | grep -i '<KEY_COLUMN>'
```

预期看到列定义中包含关键列。若不存在 → 目标应用版本过低，DB schema 尚未引入该列，升级目标应用。

### 2.2 验证有可采集的行

```bash
# 将整个 WHERE 子句替换为注册表中的过滤条件
sqlite3 "$DB" "
  SELECT COUNT(*) AS eligible_rows
  FROM <TABLE>
  WHERE <FILTER_CONDITION>;
"
```

预期：计数 > 0。若为 0 但用户确实使用了目标应用：
- 关键列存在但应用未写入数据 → 升级目标应用
- 应用写入了数据但不满足过滤条件（如非法 JSON）→ 手动检查最近几行的原始值：
  ```bash
  sqlite3 "$DB" "
    SELECT rowid, <KEY_COLUMN>
    FROM <TABLE>
    WHERE <KEY_COLUMN> IS NOT NULL AND <KEY_COLUMN> != ''
    ORDER BY rowid DESC LIMIT 5;
  "
  ```

---

## 第 3 步：游标状态检查

SQLite Input 在 `input-state.json` 中记录增量游标：Qoder / Qoder CN 使用 `lastRowId`，Qoder Work / Qoder Work CN 使用 `extra.lastUpdatedAt`。

```bash
# 将 <INPUT_ID> 替换为具体 Input ID
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 6 '"<INPUT_ID>"'
```

预期：对应 Input 存在游标字段，且值大于 0。

### 3.1 首次启动基线

pilot 首次启动时，SQLite Input 会读取当前 `MAX(rowid)` 作为基线。这意味着：
- **首次启动前已有的历史数据不会被采集**（设计如此）
- 只有启动后新产生的行才会被读取

若需要重置基线（例如升级目标应用后想从新位置开始），先让用户确认可以短暂停服，然后备份并原子替换 state 文件：

```bash
~/.local/bin/loongsuite-pilot stop
STATE="$HOME/.loongsuite-pilot/logs/input-state.json"
cp "$STATE" "$STATE.bak.$(date +%Y%m%d-%H%M%S)"
python3 - "$STATE" "<INPUT_ID>" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
input_id = sys.argv[2]
state = json.loads(path.read_text())
removed = state.pop(input_id, None)
tmp = path.with_suffix(path.suffix + '.tmp')
tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
os.replace(tmp, path)
print(f'{input_id} state removed' if removed else f'{input_id} not found in state')
PY
~/.local/bin/loongsuite-pilot start
```

### 3.2 游标卡住不前进

```bash
# 对比游标位置与 DB 中最新 rowid（使用注册表中的过滤条件）
sqlite3 "$DB" "
  SELECT MAX(rowid) AS max_rowid
  FROM <TABLE>
  WHERE <FILTER_CONDITION>;
"
```

若 DB 中 `max_rowid` > `input-state.json` 中的 `lastRowId` 但游标不前进：
- pilot 服务未运行 → `loongsuite-pilot status`
- 该 Input 未被发现启动 → 服务日志搜索 Input ID 或 `agent detected`
- DB 被锁 → 见第 5 步 SQLITE_BUSY

---

## 第 4 步：pilot 是否成功消费

```bash
# 查看 pilot 输出中对应 agentType 的数据
ls -la ~/.loongsuite-pilot/logs/output/ | grep '<AGENT_TYPE>'
tail -3 ~/.loongsuite-pilot/logs/output/<AGENT_TYPE>-$(date -u +%Y-%m-%d).jsonl 2>/dev/null \
  | python3 -m json.tool
```

预期：输出 JSONL 中包含该 Input 产出的事件。

若本地输出正常但 SLS 查不到 → 转 `sls-diagnostics.md` 排查上报链路。

---

## 第 5 步：配置与环境检查

### 5.1 轮询间隔

默认 30 秒轮询一次 SQLite。可调整：

| 配置方式 | 优先级 |
|---------|-------|
| 环境变量（如 `QODER_ANALYTICS_POLL_INTERVAL`，毫秒） | 最高（仅部分 Input 支持） |
| `config.json` → `listeners["<INPUT_ID>"].pollInterval` | 中 |
| 内置默认 30000 | 最低 |

```bash
# 检查 config.json 中对应 Input 的轮询配置
python3 -c "
import json
c=json.load(open('$HOME/.loongsuite-pilot/config.json'))
cfg=c.get('listeners',{}).get('<INPUT_ID>',{})
print('pollInterval:', cfg.get('pollInterval', '30000 (default)'))
print('enabled:', cfg.get('enabled', 'true (default)'))
" 2>/dev/null
```

### 5.2 Input 启用状态

每个 SQLite Input 可在 `config.json` 的 `listeners` 段中通过 `enabled: false` 禁用。

### 5.3 XDG_CONFIG_HOME 不一致（Linux）

Linux 上若用户自定义了 `XDG_CONFIG_HOME`，pilot 服务进程看到的路径必须与目标应用写入的路径一致：

```bash
# pilot 服务进程的环境
~/.local/bin/loongsuite-pilot status

# 当前 shell 的 XDG_CONFIG_HOME
echo "${XDG_CONFIG_HOME:-~/.config}"
```

若两者不一致，pilot 会找不到 DB 文件，表现为该 Input 始终不被发现启动。

### 5.4 SQLITE_BUSY / SQLITE_LOCKED

pilot 以 `OPEN_READONLY` 模式打开 DB，正常情况下不会与目标应用互锁。但若第三方工具以独占写模式打开同一 DB，可能导致 READONLY 打开也失败：

```bash
# 查看服务日志中的 SQLite 错误
grep -i 'sqlite\|SQLITE_BUSY\|SQLITE_LOCKED\|failed to read SQLite' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

解决方法：关闭占用 DB 的第三方工具，或等待锁释放后 pilot 会在下一个轮询周期自动恢复。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.loongsuite-pilot/logs/input-state.json` | 所有 SQLite Input 的 `lastRowId` 游标 |
| `~/.loongsuite-pilot/logs/output/` | 各 agentType 的规范化输出 JSONL |
| `~/.loongsuite-pilot/config.json` | `listeners["<INPUT_ID>"]` 配置（enabled / pollInterval） |
| `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` | 服务日志，搜索 Input ID 或 `failed to read SQLite` |

具体 DB 文件路径请查阅上方「SQLite Input 注册表」。

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| DB 文件不存在 | 目标应用未安装/未启动过/版本过低。升级到最新稳定版 |
| 目标表或关键列不存在 | 目标应用版本过低，DB schema 尚未引入。升级目标应用 |
| 有关键列但满足过滤条件的行数为 0 | 应用写入了空值或非法格式。升级目标应用 |
| `lastRowId` 游标不前进 | 1) pilot 服务未运行；2) Input 未注册（被禁用或 DB 文件不可达）；3) DB 后续无新增行 |
| 首次安装后看不到历史数据 | 设计如此——首次启动从当前 `MAX(rowid)` 开始，不补采历史。若需重采，删除 `input-state.json` 中对应 Input 条目后重启 |
| `SQLITE_BUSY` / `SQLITE_LOCKED` 错误 | 第三方工具以独占写模式占用了 DB。关闭后 pilot 自动恢复 |
| Linux 上路径不匹配 | 确保 pilot 服务进程和目标应用使用相同的 `XDG_CONFIG_HOME` 值 |
| `row transform failed` 日志 | 某行数据格式异常。不影响后续行的采集（跳过并继续） |
| 数据字段全为 0 或 null | 目标应用写入了关键列但内部字段缺失。检查应用版本 |
| 轮询间隔太大导致数据延迟 | 调整 `config.json` 的 `listeners["<INPUT_ID>"].pollInterval`（单位毫秒） |
