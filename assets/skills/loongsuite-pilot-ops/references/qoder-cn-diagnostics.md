# Qoder CN 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-cn-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Qoder CN 的本地数据采集链路**，不包含 Qoder CN 自身的功能问题。
**本文档不覆盖 Qoder IDE / Qoder CLI** —— 那两个是独立产品线，链路细节不同，
排查请阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-diagnostics.md`。

---

## 采集链路概览（三条并行链路，互斥聚合）

```
Qoder CN
  ├─ Hook (Stop / PreToolUse / PostToolUse / UserPromptSubmit)
  │    └─ ~/.qoder-cn/settings.json → qodercn-loongsuite-pilot-hook.sh
  │         └─ qoder-hook-processor.mjs --agent-id qoder-cn
  │              └─ ~/.loongsuite-pilot/logs/qoder-cn/history/qoder-cn-YYYY-MM-DD.jsonl
  │                   └─ QoderCnTraceInput（trace 聚合，若启用则接管）
  ├─ SQLite（token usage）
  │    └─ SharedClientCache/cache/db/local.db 的 chat_message.token_info
  │         └─ QoderCnSqliteInput（id=qoder-cn-sqlite）
  └─ IDE snapshot（File History + ai_tracker）
       └─ User/History/*/entries.json + SharedClientCache/cache/ai_tracker/*.jsonl
            └─ QoderCnInput（id=qoder-cn）
```

三条链路都受 `qoder-cn-trace` 是否启用的互斥控制：

- 若 `qoder-cn-trace` 未配置或为 `true`（默认）→ `qoder-cn-sqlite` 和 `qoder-cn` 自动禁用，trace 链路接管全部数据
- 只有显式设置 `qoder-cn-trace.enabled=false` 时 → `qoder-cn-sqlite`（token）和 `qoder-cn`（IDE snapshot）才作为 fallback 并行工作

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qoder-cn/settings.json` 的 `hooks.{Stop,PreToolUse,PostToolUse,UserPromptSubmit}`（nested 格式） | pilot 启动时检测到 `~/.qoder-cn/` 存在自动注入 |
| Hook 脚本 | `~/.loongsuite-pilot/hooks/qodercn-loongsuite-pilot-hook.sh` | pilot 安装/升级时拷贝 |
| 共享 processor | `~/.loongsuite-pilot/hooks/qoder-hook-processor.mjs` | pilot 安装/升级时拷贝 |
| Hook History JSONL | `~/.loongsuite-pilot/logs/qoder-cn/history/qoder-cn-YYYY-MM-DD.jsonl` | processor 增量 append |
| QoderCN 应用数据根目录（macOS） | `~/Library/Application Support/QoderCN/` | Qoder CN 应用自身写入 |
| QoderCN 应用数据根目录（Linux） | `${XDG_CONFIG_HOME:-~/.config}/QoderCN/` | Qoder CN 应用自身写入 |
| Token usage DB | `<QoderCN 根目录>/SharedClientCache/cache/db/local.db` | Qoder CN 应用写入 |
| ai_tracker 目录 | `<QoderCN 根目录>/SharedClientCache/cache/ai_tracker/*.jsonl` | Qoder CN 应用写入 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `qoder-cn` / `qoder-cn-sqlite` / `qoder-cn-trace` 条目 | 对应 Input 每次成功 flush 后更新 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/` 中 `agentType=qoder-cn` 的记录 | Flusher 写出 |

---

## 系统化排查顺序

Qoder CN 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → QoderCN 应用数据根目录是否存在 + trace/sqlite/ide 三链路互斥状态
第 2 步 → Hook 注册状态与原始 history JSONL
第 3 步 → SQLite token usage 数据验证
第 4 步 → IDE snapshot（File History + ai_tracker）数据验证
第 5 步 → pilot 是否成功消费 + 配置检查
```

---

## 第 1 步：数据根目录 + 链路互斥状态

### 1.1 QoderCN 应用数据根目录

```bash
# macOS
ls -la "$HOME/Library/Application Support/QoderCN/"
# Linux
ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/QoderCN/"
```

目录不存在 → 用户从未启动过 Qoder CN，让用户先启动一次后 `~/.local/bin/loongsuite-pilot restart`。

### 1.2 确认 `qoder-cn-trace` 是否启用（决定走哪条链路排查）

```bash
python3 - <<'PY'
import json
import pathlib
path = pathlib.Path.home() / '.loongsuite-pilot' / 'config.json'
try:
    cfg = json.loads(path.read_text())
except Exception:
    print('qoder-cn-trace.enabled: true (default)')
    raise SystemExit(0)
listener = (cfg.get('listeners') or {}).get('qoder-cn-trace') or {}
print('qoder-cn-trace.enabled:', listener.get('enabled', 'true (default)'))
PY
```

- 若未配置或为 `true`（默认）→ 只需排查第 2 步（hook history），第 3/4 步的 SQLite / IDE snapshot Input 会被自动禁用（正常现象，不是 bug）
- 若显式 `false` → 走第 3/4 步的 SQLite + IDE snapshot 双链路

---

## 第 2 步：Hook 注册状态与原始 history JSONL

### 2.1 settings.json 的 hook 注册

```bash
python3 -m json.tool ~/.qoder-cn/settings.json 2>/dev/null \
  | grep -c "qodercn-loongsuite-pilot-hook.sh"
```

预期：**4**（`Stop` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 各一条，nested 格式）。

若缺失或数量不对 → `~/.local/bin/loongsuite-pilot restart`（注入幂等）。

### 2.2 原始 history JSONL

```bash
ls -la ~/.loongsuite-pilot/logs/qoder-cn/history/
tail -2 ~/.loongsuite-pilot/logs/qoder-cn/history/qoder-cn-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

预期：每行含 `event.name`、`gen_ai.session.id`、`gen_ai.agent.type: "qoder-cn"`。

文件不存在/为空：hook 未触发，让用户在 Qoder CN 中完成一次完整对话（触发 Stop）后再看。

### 2.3 Hook 脚本可执行 + Node runtime

```bash
ls -l ~/.loongsuite-pilot/hooks/qodercn-loongsuite-pilot-hook.sh   # 需要 x 权限
cat ~/.loongsuite-pilot/node-bin
"$(cat ~/.loongsuite-pilot/node-bin)" --version                   # 应 >= v18
```

若无 x 权限或 Node 探测失败 → hook 会静默 `exit 0`（fail-open），排查 `~/.loongsuite-pilot/node-bin` 或重跑 `loongsuite-pilot restart`。

---

## 第 3 步：SQLite token usage 数据验证

### 3.1 DB 文件是否存在

```bash
# macOS
DB="$HOME/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db"
# Linux
DB="${XDG_CONFIG_HOME:-$HOME/.config}/QoderCN/SharedClientCache/cache/db/local.db"
ls -la "$DB"
```

### 3.2 是否有满足条件的行

```bash
sqlite3 "$DB" "
  SELECT COUNT(*) AS eligible_rows
  FROM chat_message
  WHERE token_info IS NOT NULL AND token_info != '' AND json_valid(token_info);
"
```

预期 > 0。为 0 但用户确实用过 Qoder CN → 升级 Qoder CN 到最新版本（老版本 `token_info` 可能未写入）。

### 3.3 游标状态

```bash
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 3 '"qoder-cn-sqlite"'
```

预期：`lastRowId` 存在且值 > 0；详细通用排查（SQLITE_BUSY、XDG_CONFIG_HOME 不一致等）见 `sqlite-diagnostics.md`。

---

## 第 4 步：IDE snapshot（File History + ai_tracker）数据验证

`QoderCnInput`（id=`qoder-cn`）同时扫描两个数据源：

### 4.1 File History（VSCode 风格编辑历史）

```bash
ls "$HOME/Library/Application Support/QoderCN/User/History/" 2>/dev/null | head -5
```

仅当 `entries.json` 中某条记录的 `source` 字段匹配 `qoder|ai|agent|copilot|assistant|completion`（大小写不敏感）时才会被采集为 AI 编辑事件。

### 4.2 ai_tracker JSONL

```bash
ls -la "$HOME/Library/Application Support/QoderCN/SharedClientCache/cache/ai_tracker/"
tail -2 "$HOME/Library/Application Support/QoderCN/SharedClientCache/cache/ai_tracker/"*.jsonl \
  | python3 -m json.tool
```

每个 tracker 文件的增量游标是 `qoder-cn-tracker:<filename>` 形式的 state key（存于 `input-state.json` 的 `lastOffset` 字段），按字节 offset 增量读取。

若两个数据源都无新增内容，但用户确实在使用 Qoder CN AI 功能编辑代码 → 确认 Qoder CN 版本是否写入 `ai_tracker`（较新版本才有此目录）。

---

## 第 5 步：pilot 是否成功消费 + 配置检查

```bash
# 5.1 三个 Input 各自的游标
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 3 '"qoder-cn"'
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 3 '"qoder-cn-sqlite"'
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 3 '"qoder-cn-trace"'

# 5.2 pilot 输出
ls -la ~/.loongsuite-pilot/logs/output/ | grep qoder-cn
```

若游标不前进：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- Input 未注册/被禁用 → 检查 `config.json` 的 `listeners["qoder-cn"]` / `["qoder-cn-sqlite"]` / `["qoder-cn-trace"]`
- 三链路互斥逻辑导致的预期禁用（见第 1.2 步）不是异常

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qoder-cn/settings.json` | Qoder CN 的 hook 注册（4 个事件，nested 格式） |
| `~/.loongsuite-pilot/hooks/qodercn-loongsuite-pilot-hook.sh` | Qoder CN 专用 shell 入口 |
| `~/.loongsuite-pilot/hooks/qoder-hook-processor.mjs` | 共享 hook processor |
| `~/.loongsuite-pilot/logs/qoder-cn/history/qoder-cn-YYYY-MM-DD.jsonl` | Hook 链路的原始 JSONL |
| `<QoderCN 根目录>/SharedClientCache/cache/db/local.db` | SQLite token usage DB |
| `<QoderCN 根目录>/SharedClientCache/cache/ai_tracker/*.jsonl` | AI 编辑事件跟踪文件 |
| `<QoderCN 根目录>/User/History/*/entries.json` | 编辑历史快照 |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `qoder-cn` / `qoder-cn-sqlite` / `qoder-cn-trace` 游标 |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出（`gen_ai.agent.type: "qoder-cn"`） |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| Qoder CN 完全无数据 | 先确认应用数据根目录存在（用户至少启动过一次），再 `loongsuite-pilot restart` |
| hook 已注入但 history 目录为空 | 用户在注入后没有完整结束过一次对话；提示用户完成一次对话再看 |
| SQLite token usage 为 0 但 IDE snapshot 有数据 | 版本过旧未写入 `token_info`，或 `qoder-cn-trace` 已启用压制了 sqlite Input（检查第 1.2 步） |
| IDE snapshot 无数据但 SQLite 有数据 | File History 中 `source` 字段未命中 AI 关键字过滤，或 `ai_tracker` 目录尚未产生（版本差异），均属正常现象 |
| 同时看到 `qoder-cn` 和 `qoder-cn-sqlite` 都无游标前进，但 `qoder-cn-trace` 有 | trace 链路已启用并接管数据，属预期互斥，检查 trace 链路即可 |
| Linux 上路径不匹配 | 确保 pilot 服务进程和 Qoder CN 应用使用相同的 `XDG_CONFIG_HOME` 值 |
