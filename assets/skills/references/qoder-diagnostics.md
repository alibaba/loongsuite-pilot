# Qoder IDE / CLI 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/qoder-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下的 Qoder 本地数据采集链路**，不包含 OTLP trace 远端导出排查。
**本文档不覆盖 Qoder Work** —— Qoder Work 是独立产品，链路与 Qoder IDE/CLI 完全不同，
排查请阅读 `~/.loongsuite-pilot/skills/references/qoderwork-diagnostics.md`。

---

## 采集链路概览（Qoder 有 4 条独立数据源）

与 Cursor / Claude Code / Codex 只有一条 hook 链路不同，Qoder 的数据分别来自 4 个 Input，任何一条掉链都会导致**部分**字段缺失：

| # | Input id | agentType | 数据源 | 作用 |
|---|---------|-----------|-------|------|
| 1 | `qoder-cli-hook` | `qoder-cli` / `qoder` | `~/.loongsuite-pilot/logs/qoder-cli/history/qoder-cli-*.jsonl`（由 hook 转发 transcript 而来） | Qoder CLI 的 Chat / Tool call 详情 |
| 2 | `qoder-cli-session` | `qoder-cli` | `~/.qoder/logs/sessions/<cwd>/<session>/segments/*.jsonl` | Qoder CLI 的 token 使用量（llm.response） |
| 3 | `qoder` | `qoder` | `~/Library/Application Support/Qoder/` (mac) / `~/.config/Qoder/` (linux) 下的 `User/History/` + `SharedClientCache/cache/ai_tracker/*.jsonl` | Qoder IDE 的文件编辑活动 |
| 4 | `qoder-sqlite` | `qoder` | `SharedClientCache/cache/db/local.db` 的 `chat_message` 表 | Qoder IDE 的 token 使用量 |

> **排查前先确认用户使用的是 Qoder IDE 还是 Qoder CLI**，再挑对应的链路走，不要把 4 条全排一遍。
>
> - 用户问"CLI 为什么没数据"→ 只看第 1、2 条  
> - 用户问"IDE 为什么没数据"→ 只看第 3、4 条

---

## 系统化排查顺序

```
第 1 步 → Qoder 版本（低版本不支持 Stop hook / 产生不了 session segments / 表结构缺字段）
第 2 步 → 根据用户场景选链路：CLI（hook + session）或 IDE（history + sqlite）
第 3 步 → pilot 是否成功消费（input-state 推进 + output 产出）
第 4 步 → 配置文件对照检查
```

---

## 第 1 步：Qoder 版本检查（特殊必查）

Qoder 是**唯一一个** pilot 支持但对 agent 版本有硬性要求的场景。低版本常见表现：

| 场景 | 低版本表现 |
|------|-----------|
| Qoder CLI | 不认识 `~/.qoder/settings.json` 里的 `hooks.Stop` → history 目录始终为空；或者 `~/.qoder/logs/sessions/` 根本不生成 segment 文件 |
| Qoder CLI | 老版本 CLI 短选项 / 参数格式差异，导致用户日常命令行为异常（已知 `0.2.12` 起移除 `-q` 等），虽然不影响采集本身，但常让用户误以为"插件失效" |
| Qoder IDE | `SharedClientCache/cache/db/local.db` 里 `chat_message` 表无 `token_info` 列 → SQLite Input 读到 0 行；或 `SharedClientCache/cache/ai_tracker/` 目录不存在 |

排查方法：

```bash
# Qoder CLI
qoder --version 2>/dev/null || qodercli --version 2>/dev/null

# Qoder IDE：从菜单 / About 查看；或查看安装目录下的 package.json
```

处理方法：
- **升级 Qoder 到最新稳定版**，重启 IDE / 重新拉起 CLI
- 如果用户明确拒绝升级 → 直接告知在当前版本下 pilot 无法完整采集，结束排查

> ⚠️ 这是 Qoder 排查中**最常见**的根因。其它 agent（Claude Code / Codex）的特殊问题（trust / duplicate key / settings 覆盖）在 Qoder 场景下都不适用，不要照搬排查思路。

---

## 第 2 步（A）：Qoder CLI 链路

### 2.A.1 Hook 注册状态

pilot 启动时检测到 `~/.qoder/` 目录存在，会把 hook 注入 `~/.qoder/settings.json` 的 `hooks.Stop`，**nested 格式**：

```bash
python3 -m json.tool ~/.qoder/settings.json \
  | grep -c "qoder-loongsuite-pilot-hook.sh qoder-cli"
```

预期输出：**1**。对应的 settings.json 片段：

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "command": "/Users/<you>/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-cli", "type": "command" }
        ]
      }
    ]
  }
}
```

若缺失 → `~/.local/bin/loongsuite-pilot restart`（注入幂等，不会重复写）。

> Qoder CLI 只注入 `Stop` 一个事件，由 `hook-processor.mjs` 根据 `transcript_path` 增量拉取 transcript，**不需要**也**不会**像 Codex 那样注入 5 个事件。

### 2.A.2 原始 transcript + history

Qoder CLI 本身把完整对话写入 session segment：

```bash
ls -la ~/.qoder/logs/sessions/ | head    # 按 cwd 分目录
# 目录结构：<cwd-key>/<session-id>/segments/<segment>.jsonl
find ~/.qoder/logs/sessions -name '*.jsonl' -newer /tmp -mmin -60 | head -5
```

如果 sessions 目录**不存在**或**全空** → Qoder CLI 自身没有写入 transcript，100% 是 **Qoder CLI 版本过低**，回第 1 步升级。

Stop hook 触发后，`hook-processor.mjs` 会把 transcript 新增行增量 append 到：

```bash
ls -la ~/.loongsuite-pilot/logs/qoder-cli/history/
tail -2 ~/.loongsuite-pilot/logs/qoder-cli/history/qoder-cli-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

processor 的增量状态保存在：

```bash
cat ~/.loongsuite-pilot/hooks/.line_records.qoder-cli.json
# 每个 transcript_path → { session_id, last_line_count, updated_at }
```

若 history 为空但 sessions 有数据：
- hook 从未被触发 → 检查第 2.A.1 的 settings.json
- hook 被触发但 transcript_path 或 session_id 缺失 → 看 debug 日志：
  ```bash
  ls ~/.loongsuite-pilot/logs/qoder-cli/debug/
  tail -50 ~/.loongsuite-pilot/logs/qoder-cli/debug/qoder-cli-debug-$(date -u +%Y-%m-%d).log
  ```
  常见日志关键字：`No transcript_path or session_id`、`Transcript file not found`、`No new lines`

### 2.A.3 Session segments（token 使用量独立链路）

`qoder-cli-session` Input 不依赖 hook，直接扫描 segment 文件。即使 hook 未注入，只要 Qoder CLI 能写 segments，token 数据就能采到：

```bash
# 确认 segment 里有 model.response.completed 事件
grep -h '"type":"model.response.completed"' \
  ~/.qoder/logs/sessions/*/*/segments/*.jsonl 2>/dev/null | wc -l
```

若为 0 → Qoder CLI 版本过低，不产生该事件类型，升级即可。

---

## 第 2 步（B）：Qoder IDE 链路

### 2.B.1 数据根目录存在性

```bash
# macOS
ls -la "$HOME/Library/Application Support/Qoder"
# Linux
ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/Qoder"
```

目录不存在 → Qoder IDE 从未启动过，或 IDE 版本老到不使用这个目录，回第 1 步升级。

### 2.B.2 文件历史 + ai_tracker

`qoder` Input 从两个子目录采集：

```bash
# 1) VSCode-style 文件编辑历史（按 source 字段筛 AI 来源）
ls "$HOME/Library/Application Support/Qoder/User/History/" | head

# 2) AI tracker JSONL
ls -la "$HOME/Library/Application Support/Qoder/SharedClientCache/cache/ai_tracker/"
```

若 `ai_tracker/` 目录不存在 → Qoder IDE 版本过低未启用追踪，升级即可。

### 2.B.3 SQLite token 数据

`qoder-sqlite` Input 读这个 DB，提取 `chat_message.token_info`：

```bash
DB="$HOME/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db"
ls -l "$DB"

# 只读验证 token_info 是否存在（需要系统自带 sqlite3）
sqlite3 "$DB" "SELECT COUNT(*) FROM chat_message WHERE token_info IS NOT NULL AND token_info != '' AND json_valid(token_info);"
```

预期：计数 > 0。若为 0 且用户确实使用了 Qoder IDE：
- **Qoder IDE 版本过低**，`chat_message.token_info` 没写入或列不存在
- 首次启动 pilot 时，`qoder-sqlite` Input 会把 cursor 定位到当前最大 rowid（baseline），**只采集之后新产生的**行。若升级后仍无数据，可能是继续停留在老基线上，处理方法：
  ```bash
  # 删掉该 input 的 state 条目后 restart，注意这只会重新采 "之后新增"，无法补历史
  jq 'del(.inputs."qoder-sqlite")' ~/.loongsuite-pilot/logs/input-state.json \
    > /tmp/is.json && mv /tmp/is.json ~/.loongsuite-pilot/logs/input-state.json
  ~/.local/bin/loongsuite-pilot restart
  ```

---

## 第 3 步：pilot 是否成功消费

```bash
# 3.1 input-state 中的四个游标
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool \
  | grep -E -A 3 '"qoder(|-cli-hook|-cli-session|-sqlite)"'

# 3.2 pilot 输出（按 agentType 前缀平铺）
ls -la ~/.loongsuite-pilot/logs/output/ | grep -E 'qoder(-cli)?'
tail -2 ~/.loongsuite-pilot/logs/output/qoder-cli-$(date -u +%Y-%m-%d).jsonl
tail -2 ~/.loongsuite-pilot/logs/output/qoder-$(date -u +%Y-%m-%d).jsonl
```

每个 Input 对应的游标字段：

| Input | 游标字段 | 含义 |
|-------|---------|------|
| `qoder-cli-hook` | `lastFile` + `lastOffset` | 当天 history JSONL 的字节偏移 |
| `qoder-cli-session` | 每个 segment 文件的 `lastOffset` | 多文件独立字节偏移 |
| `qoder` | `lastOffset`（per ai_tracker 文件） + SnapshotStore | 文件历史按时间戳+快照 dedup |
| `qoder-sqlite` | `lastRowId` | `chat_message.rowid` 游标 |

游标不前进的通用排查：
- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- 对应 Input 未注册 → `tail ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`，搜 Input id
- 原始数据确实没新增（第 2 步的源为空）→ 回第 2 步

---

## 第 4 步：配置文件对照检查

#### 4.1 `~/.qoder/settings.json`（CLI 场景）

```bash
python3 -m json.tool ~/.qoder/settings.json | grep -A 8 '"Stop"'
```

预期：`hooks.Stop` 数组里至少有一项以 nested 格式（外层 `matcher` + 内层 `hooks[]`）指向 `qoder-loongsuite-pilot-hook.sh qoder-cli`。

> Qoder **nested 格式**与 Cursor **flat 格式**不同，不要混。

#### 4.2 Hook 脚本 + processor 可执行

```bash
ls -l ~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh   # 需要 x 权限
ls -l ~/.loongsuite-pilot/hooks/hook-processor.mjs               # CLI 和 Work 共用
```

#### 4.3 Node runtime pin

```bash
cat ~/.loongsuite-pilot/node-bin
"$(cat ~/.loongsuite-pilot/node-bin)" --version   # >= v18
```

与 Cursor 共用一份 pin 文件，失效时 shell 会按 `~/.nvm/*` → volta → fnm → homebrew → `/usr/local` → `~/.local` → `$(command -v node)` fallback。

#### 4.4 Qoder 数据根是否被环境覆盖

`qoder` / `qoder-sqlite` Input 默认按平台解析：
- mac：`~/Library/Application Support/Qoder`
- linux：`$XDG_CONFIG_HOME/Qoder` 或 `~/.config/Qoder`

若用户改动了 `XDG_CONFIG_HOME`，pilot 服务进程看到的值必须一致：

```bash
~/.local/bin/loongsuite-pilot status      # 查看 pilot 服务的启动环境
ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/Qoder"
```

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qoder/settings.json` | Qoder CLI 的 hook 注册（`hooks.Stop`，nested 格式） |
| `~/.qoder/logs/sessions/<cwd>/<session>/segments/*.jsonl` | Qoder CLI 原生 transcript + token 事件（`qoder-cli-session` Input 源） |
| `~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh` | Qoder CLI / Work 共用的 shell 入口 |
| `~/.loongsuite-pilot/hooks/hook-processor.mjs` | 共享 transcript forwarder（从 stdin 拿 transcript_path，增量 append 到 history） |
| `~/.loongsuite-pilot/hooks/.line_records.qoder-cli.json` | processor 的增量行记录状态 |
| `~/.loongsuite-pilot/logs/qoder-cli/history/qoder-cli-YYYY-MM-DD.jsonl` | transcript 转发后的 history（`qoder-cli-hook` Input 源） |
| `~/.loongsuite-pilot/logs/qoder-cli/debug/qoder-cli-debug-*.log` | processor 调试日志 |
| `~/Library/Application Support/Qoder/User/History/` | IDE 文件编辑历史（`qoder` Input 源之一） |
| `~/Library/Application Support/Qoder/SharedClientCache/cache/ai_tracker/*.jsonl` | AI 追踪 JSONL（`qoder` Input 源之二） |
| `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` | IDE SQLite（`qoder-sqlite` Input 源） |
| `~/.loongsuite-pilot/logs/output/qoder-cli-YYYY-MM-DD.jsonl` | CLI 规范化输出 |
| `~/.loongsuite-pilot/logs/output/qoder-YYYY-MM-DD.jsonl` | IDE 规范化输出 |
| `~/.loongsuite-pilot/logs/input-state.json` | 4 个 Qoder Input 的游标 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| **Qoder / Qoder CLI 完全无数据** | **先和用户确认用的是桌面版 Qoder（独立应用）**，而不是 IntelliJ IDEA 里的 Qoder 插件 —— 后者暂不支持（仍在开发中），pilot 不会采到任何数据。确认是桌面版后再继续往下查 |
| **Qoder CLI 完全无数据** | **首查 Qoder CLI 版本**。老版本不执行 `hooks.Stop`，也可能不写 session segments。升级到最新稳定版后 `loongsuite-pilot restart` |
| **Qoder IDE 完全无数据** | **首查 Qoder IDE 版本**。老版本缺 `ai_tracker/` 目录或 `chat_message.token_info` 字段。升级 Qoder 后重启 IDE |
| Qoder Work（`~/.qoderwork/`）用户问怎么排查 | Qoder Work 已独立支持，链路与本文档不同，直接阅读 `~/.loongsuite-pilot/skills/references/qoderwork-diagnostics.md` |
