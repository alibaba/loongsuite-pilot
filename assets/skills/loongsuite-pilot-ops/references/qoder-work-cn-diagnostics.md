# Qoder Work CN 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-work-cn-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Qoder Work CN 的本地数据采集链路**，不包含 Qoder Work CN 自身的功能问题。
**本文档不覆盖 Qoder Work 标准版** —— 标准版使用 `~/.qoderwork/` 与 `qoder-work` agentType，
排查请阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoderwork-diagnostics.md`。

---

## 采集链路概览（CN 版四链路，trace 可接管）

```
Qoder Work CN
  ├─ Stop hook (~/.qoderworkcn/settings.json)
  │    └─ qoderworkcn-loongsuite-pilot-hook.sh
  │         └─ qoderwork-hook-processor.mjs --agent-id qoder-work-cn
  │              └─ ~/.loongsuite-pilot/logs/qoder-work-cn/history/qoder-work-cn-YYYY-MM-DD.jsonl
  │                   └─ QoderWorkInput (id=qoder-work-cn-hook)
  ├─ SDK log tail
  │    └─ <QoderWork CN 根目录>/logs/...
  │         └─ QoderWorkLogInput (id=qoder-work-cn-log)
  ├─ SQLite agents.db
  │    └─ <QoderWork CN 根目录>/data/agents.db
  │         └─ QoderWorkSqliteInput (id=qoder-work-cn-sqlite)
  └─ Trace 聚合
       └─ QoderWorkCNTraceInput (id=qoder-work-cn-trace)
```

若 `qoder-work-cn-trace` 启用，`qoder-work-cn-hook` / `qoder-work-cn-log` / `qoder-work-cn-sqlite` 会被自动禁用，trace 链路接管数据。
当前 `qoder-work-cn-trace` 默认 `enabled: false`，通常先排查 hook/log/sqlite fallback。

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qoderworkcn/settings.json` 的 `hooks.Stop`（nested 格式） | pilot 启动时检测到 `~/.qoderworkcn/` 存在自动注入 |
| Hook 脚本 | `~/.loongsuite-pilot/hooks/qoderworkcn-loongsuite-pilot-hook.sh` | pilot 安装/升级时拷贝 |
| 共享 processor | `~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs` | pilot 安装/升级时拷贝 |
| Hook History JSONL | `~/.loongsuite-pilot/logs/qoder-work-cn/history/qoder-work-cn-YYYY-MM-DD.jsonl` | processor 增量 append |
| QoderWork CN 数据根目录（macOS） | `~/Library/Application Support/QoderWork CN/` | Qoder Work CN 应用写入 |
| QoderWork CN 数据根目录（Linux） | `${XDG_CONFIG_HOME:-~/.config}/QoderWork CN/` | Qoder Work CN 应用写入 |
| SQLite DB | `<QoderWork CN 根目录>/data/agents.db` | Qoder Work CN 应用写入 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `qoder-work-cn-*` 条目 | 对应 Input 每次成功 flush 后更新 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/qoder-work-cn-YYYY-MM-DD.jsonl` 或 output 平铺文件 | Flusher 写出 |

---

## 系统化排查顺序

Qoder Work CN 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → ~/.qoderworkcn/ 与 QoderWork CN 应用数据根目录是否存在
第 2 步 → trace 是否启用（决定排查 trace 还是 fallback）
第 3 步 → Stop hook 注册与原始 history JSONL
第 4 步 → SDK log / SQLite fallback 数据验证
第 5 步 → pilot 是否成功消费 + 配置检查
```

---

## 第 1 步：目录存在性

### 1.1 Hook 配置目录

```bash
ls -la ~/.qoderworkcn/
```

目录不存在 → 用户从未启动过 Qoder Work CN，让用户先启动一次后 `~/.local/bin/loongsuite-pilot restart`。

### 1.2 应用数据根目录

```bash
# macOS
ls -la "$HOME/Library/Application Support/QoderWork CN/"
# Linux
ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/QoderWork CN/"
```

该目录提供 SDK log 与 `data/agents.db`。如果 `~/.qoderworkcn/` 存在但应用数据根目录不存在，通常是应用版本或安装形态差异，先走 hook 链路排查。

---

## 第 2 步：确认 trace 是否启用

```bash
python3 - <<'PY'
import json
import pathlib
path = pathlib.Path.home() / '.loongsuite-pilot' / 'config.json'
try:
    cfg = json.loads(path.read_text())
except Exception:
    print('qoder-work-cn-trace.enabled: false (default)')
    raise SystemExit(0)
listener = (cfg.get('listeners') or {}).get('qoder-work-cn-trace') or {}
print('qoder-work-cn-trace.enabled:', listener.get('enabled', 'false (default)'))
PY
```

- 若 `enabled: true` → trace 链路接管，`qoder-work-cn-hook` / `qoder-work-cn-log` / `qoder-work-cn-sqlite` 无游标前进属于预期
- 若未配置或为 `false`（默认）→ 继续排查 hook/log/sqlite fallback

---

## 第 3 步：Stop hook 注册与原始 history JSONL

### 3.1 settings.json 的 Stop hook

```bash
python3 -m json.tool ~/.qoderworkcn/settings.json 2>/dev/null \
  | grep -c "qoderworkcn-loongsuite-pilot-hook.sh\|qoder-loongsuite-pilot-hook.sh qoder-work-cn"
```

预期输出：**1**。若缺失 → `~/.local/bin/loongsuite-pilot restart`（注入幂等）。

> 旧版可能指向 `qoder-loongsuite-pilot-hook.sh qoder-work-cn`，restart 后会替换为专用入口 `qoderworkcn-loongsuite-pilot-hook.sh`。

### 3.2 原始 history JSONL

```bash
ls -la ~/.loongsuite-pilot/logs/qoder-work-cn/history/
tail -2 ~/.loongsuite-pilot/logs/qoder-work-cn/history/qoder-work-cn-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

预期：每行是 canonical hook 记录、PostToolUse 记录或 assistant/user transcript 行，`gen_ai.agent.type` 最终应为 `qoder-work-cn`。

若 history 目录为空：

- 用户在 hook 注入之后还没结束过一次完整对话（Stop 未触发）
- Stop payload 缺 `transcript_path` 或 `session_id`，查看 debug/error：
  ```bash
  tail -50 ~/.loongsuite-pilot/logs/qoder-work-cn/debug/qoder-work-cn-debug-$(date -u +%Y-%m-%d).log
  tail -50 ~/.loongsuite-pilot/logs/qoder-work-cn/errors/qoder-work-cn-error-$(date -u +%Y-%m-%d).log
  ```

### 3.3 Hook 脚本可执行 + Node runtime

```bash
ls -l ~/.loongsuite-pilot/hooks/qoderworkcn-loongsuite-pilot-hook.sh   # 需要 x 权限
ls -l ~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs
cat ~/.loongsuite-pilot/node-bin
"$(cat ~/.loongsuite-pilot/node-bin)" --version                       # 应 >= v18
```

---

## 第 4 步：SDK log / SQLite fallback 数据验证

### 4.1 SDK log tail

```bash
# macOS
ROOT="$HOME/Library/Application Support/QoderWork CN"
# Linux
ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/QoderWork CN"
ls -la "$ROOT/logs"
```

`QoderWorkLogInput`（id=`qoder-work-cn-log`）从该 logs 目录解析模型、会话、工具等 SDK 日志。目录不存在或为空时，此链路不会启动。

### 4.2 SQLite agents.db

```bash
DB="$ROOT/data/agents.db"
ls -la "$DB"
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "
  SELECT COUNT(*) AS eligible_rows
  FROM messages m
  WHERE m.parts IS NOT NULL AND m.parts != '' AND m.parts != '[]';
"
```

预期：存在 `messages` / `sub_chats` 表，eligible_rows > 0。

`qoder-work-cn-sqlite` 使用 `input-state.json` 的 `extra.lastUpdatedAt` 作为游标：

```bash
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 6 '"qoder-work-cn-sqlite"'
```

---

## 第 5 步：pilot 是否成功消费 + 配置检查

```bash
# 5.1 fallback 三链路游标
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 4 '"qoder-work-cn-hook"'
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 4 '"qoder-work-cn-log"'
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 6 '"qoder-work-cn-sqlite"'

# 5.2 trace 链路游标
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 4 '"qoder-work-cn-trace"'

# 5.3 输出
ls -la ~/.loongsuite-pilot/logs/output/ | grep qoder-work-cn
```

若游标不前进：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `qoder-work-cn-trace` 启用导致 fallback 被压制（见第 2 步）
- Input 被配置禁用 → 检查 `listeners["qoder-work-cn-hook"]` / `["qoder-work-cn-log"]` / `["qoder-work-cn-sqlite"]` / `["qoder-work-cn-trace"]`
- 应用数据根目录路径与 `XDG_CONFIG_HOME` 不一致

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qoderworkcn/settings.json` | Qoder Work CN 的 Stop hook 注册（nested 格式） |
| `~/.loongsuite-pilot/hooks/qoderworkcn-loongsuite-pilot-hook.sh` | Qoder Work CN 专用 shell 入口 |
| `~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs` | 共享 transcript forwarder |
| `~/.loongsuite-pilot/hooks/.line_records.qoder-work-cn.json` | processor 的 per-transcript 增量行记录状态 |
| `~/.loongsuite-pilot/logs/qoder-work-cn/history/qoder-work-cn-YYYY-MM-DD.jsonl` | Hook 转发后的 history |
| `~/Library/Application Support/QoderWork CN/logs/` | SDK log tail 数据源（macOS） |
| `~/Library/Application Support/QoderWork CN/data/agents.db` | SQLite fallback 数据源（macOS） |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `qoder-work-cn-*` 游标 |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| Qoder Work CN 完全无数据 | 先确认 `~/.qoderworkcn/` 存在，再 `loongsuite-pilot restart` 注入 hook |
| settings 中无 Stop hook | `loongsuite-pilot restart`，注入是幂等的 |
| history 为空但 hook 已注入 | 用户还没结束过一次完整对话；让用户发一句完整对话并结束后再看 |
| fallback 三链路都无游标，但 `qoder-work-cn-trace` 有游标 | trace 链路已启用并接管数据，属预期互斥 |
| SQLite DB 不存在 | 用户未启动过新版 Qoder Work CN，或应用数据根目录与预期不一致 |
| SDK logs 目录不存在 | SDK log tail 链路不可用，先看 hook history 与 SQLite |
| `[loongsuite-pilot] node >= 18 not found` | 系统找不到合适 Node。装 Node ≥ 18 并写入 `~/.loongsuite-pilot/node-bin`，或重跑安装/重启 |
| Linux 上路径不匹配 | 确保 pilot 服务进程和 Qoder Work CN 应用使用相同的 `XDG_CONFIG_HOME` 值 |
