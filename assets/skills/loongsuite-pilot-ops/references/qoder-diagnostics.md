# Qoder IDE / CLI 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下的 Qoder 本地数据采集链路**，不包含 OTLP trace 远端导出排查。
**本文档不覆盖 Qoder for JetBrains** —— JetBrains 插件使用 `qoder-idea` agentType 与共享 `qoder-trace` 链路，
排查请阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-jetbrains-diagnostics.md`。
**本文档不覆盖 Qoder Work** —— Qoder Work 是独立产品，链路与 Qoder IDE/CLI 完全不同，
排查请阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoderwork-diagnostics.md`。

---

## 采集链路概览（默认 qoder-trace 聚合链路）

Qoder 默认由 `qoder-trace` 聚合 Hook JSONL、CLI session segments 和 SQLite token 数据；
`qoder-cli-hook` / `qoder-cli-session` / `qoder-sqlite` 是 **显式关闭 `qoder-trace` 后的 fallback**，默认不会启动。

| # | Input id | agentType | 数据源 | 作用 |
|---|---------|-----------|-------|------|
| 1 | `qoder-trace` | `qoder` / `qoder-cli` / `qoder-idea` | `~/.loongsuite-pilot/logs/qoder/history/qoder-*.jsonl` + `~/.qoder/logs/sessions/.../segments/*.jsonl` + Qoder SQLite DB | 默认主链路：Chat / Tool call 结构、CLI token fallback、IDE/JetBrains token enrichment |
| 2 | `qoder-cli-hook` | `qoder-cli` | `~/.loongsuite-pilot/logs/qoder/history/qoder-*.jsonl` | 仅 `qoder-trace` 显式关闭时的 Hook JSONL fallback |
| 3 | `qoder-cli-session` | `qoder-cli` | `~/.qoder/logs/sessions/<cwd>/<session>/segments/*.jsonl` | 仅 `qoder-trace` 显式关闭时的 CLI token fallback |
| 4 | `qoder-sqlite` | `qoder` | Qoder DB `SharedClientCache/cache/db/local.db` 的 `chat_message` 表 | 仅 `qoder-trace` 显式关闭时的 IDE token fallback |

> **排查前先确认用户使用的是 Qoder IDE、Qoder CLI 还是 Qoder for JetBrains**。
>
> - 用户问 "CLI 为什么没数据" → 默认看 `qoder-trace` + CLI session + qodercli intercept
> - 用户问 "IDE 为什么没数据" → 默认看 `qoder-trace` + Qoder SQLite
> - 用户问 "JetBrains 为什么没数据" → 转 `qoder-jetbrains-diagnostics.md`

---

## 系统化排查顺序

```
第 1 步 → Qoder 版本（低版本不支持 Stop hook / 产生不了 session segments / 表结构缺字段）
第 2 步 → 根据用户场景选链路：CLI（hook + session + 依赖注入）或 IDE（history + sqlite）
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
  | grep -c "qoder-loongsuite-pilot-hook.sh"
```

预期输出：**1**。对应的 settings.json 片段：

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "command": "/Users/<you>/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh", "type": "command" }
        ]
      }
    ]
  }
}
```

若缺失 → `~/.local/bin/loongsuite-pilot restart`（注入幂等，不会重复写）。

> Qoder CLI 只注入 `Stop` 一个事件，由 `qoder-hook-processor.mjs` 根据 `transcript_path` 增量拉取 transcript，**不需要**也**不会**像 Codex 那样注入 5 个事件。

### 2.A.2 原始 transcript + history

Qoder CLI 本身把完整对话写入 session segment：

```bash
ls -la ~/.qoder/logs/sessions/ | head    # 按 cwd 分目录
# 目录结构：<cwd-key>/<session-id>/segments/<segment>.jsonl
find ~/.qoder/logs/sessions -name '*.jsonl' -newer /tmp -mmin -60 | head -5
```

如果 sessions 目录**不存在**或**全空** → Qoder CLI 自身没有写入 transcript，100% 是 **Qoder CLI 版本过低**，回第 1 步升级。

Stop hook 触发后，`qoder-hook-processor.mjs` 会把 transcript 新增行增量 append 到：

```bash
ls -la ~/.loongsuite-pilot/logs/qoder/history/
tail -2 ~/.loongsuite-pilot/logs/qoder/history/qoder-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

processor 的增量状态保存在：

```bash
ls -la ~/.loongsuite-pilot/state/hooks/qoder-line-records/
cat ~/.loongsuite-pilot/state/hooks/qoder-line-records/*.json
# 每个文件对应一个 session，内容含 session_id、transcript_path、last_line_count、updated_at
```

同目录下的 `qoder-line-records.json` 是加锁维护的旧版本回滚兼容影子；当前版本以
`qoder-line-records/*.json` 为主状态。

若 history 为空但 sessions 有数据：
- hook 从未被触发 → 检查第 2.A.1 的 settings.json
- hook 被触发但 transcript_path 或 session_id 缺失 → 看 debug 日志：
  ```bash
  ls ~/.loongsuite-pilot/logs/qoder/debug/
  tail -50 ~/.loongsuite-pilot/logs/qoder/debug/qoder-debug-$(date -u +%Y-%m-%d).log
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

### 2.A.4 依赖注入校验（qodercli token / system prompt preload）

`qoder-trace` 会优先读取 session segments 中的 token；当 qodercli 某些版本 segment token 为 0 或缺少 system prompt 时，
会回退读取 `qodercli-token-intercept.mjs` 写出的 `qodercli-intercept.jsonl`。这一步依赖 shell rc 中的
`BUN_OPTIONS --preload` 包装函数，缺失时表现为 **Chat / Tool call 有数据，但 token 或 system prompt 缺失 / 全 0**。

```bash
# 1) preload 脚本必须存在
ls -l ~/.loongsuite-pilot/hooks/qodercli-token-intercept.mjs

# 2) shell rc 中必须有注入块（zsh/bash 至少一个命中）
grep -n 'loongsuite-pilot BEGIN qodercli-intercept\|qodercli-token-intercept.mjs' \
  ~/.zshrc ~/.bashrc 2>/dev/null

# 3) 当前终端必须已经 source 过 rc，qodercli 应显示为 shell function
type qodercli 2>/dev/null
```

预期 `type qodercli` 能看到类似：

```bash
qodercli is a function
qodercli () { BUN_OPTIONS="--preload=/Users/<you>/.loongsuite-pilot/hooks/qodercli-token-intercept.mjs" command qodercli "$@"; }
```

若第 2 步有注入块但第 3 步仍不是 function → 用户需要执行 `source ~/.zshrc` / `source ~/.bashrc` 或打开新终端。

完成一次 qodercli 对话后验证 intercept 文件：

```bash
ls -l ~/.loongsuite-pilot/logs/qodercli-intercept.jsonl
tail -20 ~/.loongsuite-pilot/logs/qodercli-intercept.jsonl | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({
        "type": r.get("type"),
        "id": r.get("id"),
        "model": r.get("model"),
        "prompt_tokens": r.get("prompt_tokens"),
        "completion_tokens": r.get("completion_tokens"),
        "has_content": bool(r.get("content")),
    })
'
```

预期能看到 `type: "token"` 或 `type: "system_prompt"` 记录。若文件不存在但 qodercli 对话正常，说明 preload 未生效；
重跑安装或等待 HookWatchdog 自动修复 shell rc 注入块后，必须重新 source rc / 新开终端。

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

### 2.B.2 Hook history（Chat / Tool call 结构）

Qoder IDE 和 Qoder CLI 共用 `~/.qoder/settings.json` 的 Stop hook，processor 写入同一个 history 目录：

```bash
python3 -m json.tool ~/.qoder/settings.json 2>/dev/null | grep -A 8 '"Stop"'
ls -la ~/.loongsuite-pilot/logs/qoder/history/
tail -2 ~/.loongsuite-pilot/logs/qoder/history/qoder-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

若 history 为空但 Qoder IDE 已产生对话：检查 `~/.qoder/settings.json` 的 Stop hook 是否指向
`qoder-loongsuite-pilot-hook.sh`，以及 `~/.loongsuite-pilot/logs/qoder/debug/qoder-debug-*.log`。

### 2.B.3 SQLite token 数据

`qoder-trace` 默认读取这个 DB，提取 `chat_message.token_info`；显式关闭 `qoder-trace` 后，`qoder-sqlite` 才作为 fallback 单独启动：

```bash
DB="$HOME/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db"
ls -l "$DB"

# 只读验证 token_info 是否存在（需要系统自带 sqlite3）
sqlite3 "$DB" "SELECT COUNT(*) FROM chat_message WHERE token_info IS NOT NULL AND token_info != '' AND json_valid(token_info);"
```

预期：计数 > 0。若为 0 且用户确实使用了 Qoder IDE：
- **Qoder IDE 版本过低**，`chat_message.token_info` 没写入或列不存在
- `qoder-trace` 首次启动时会把 cursor 定位到当前最大行附近，**只采集之后新产生的**数据；升级或修复后需重新触发一次新对话验证

---

## 第 3 步：pilot 是否成功消费

```bash
# 3.1 input-state 中的四个游标
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool \
  | grep -E -A 3 '"qoder(-trace|-cli-hook|-cli-session|-sqlite)?"'

# 3.2 pilot 输出（只投影元数据，避免打印 prompt/tool 内容）
ls -la ~/.loongsuite-pilot/logs/output/ | grep -E 'qoder(-cli)?'
for f in ~/.loongsuite-pilot/logs/output/qoder-cli-$(date -u +%Y-%m-%d).jsonl ~/.loongsuite-pilot/logs/output/qoder-$(date -u +%Y-%m-%d).jsonl; do
  [ -f "$f" ] && tail -20 "$f" | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({"event.name": r.get("event.name"), "agent": r.get("gen_ai.agent.type"), "session": r.get("gen_ai.session.id")})
'
done
```

每个 Input 对应的游标字段：

| Input | 游标字段 | 含义 |
|-------|---------|------|
| `qoder-trace` | `lastFile` + `lastOffset` | 默认主链路读取 `logs/qoder/history/qoder-YYYY-MM-DD.jsonl` 的字节偏移 |
| `qoder-cli-hook` | `lastFile` + `lastOffset` | `qoder-trace` 显式关闭时的 Hook JSONL fallback |
| `qoder-cli-session` | 每个 segment 文件的 `lastOffset` | `qoder-trace` 显式关闭时的 CLI token fallback |
| `qoder-sqlite` | `lastRowId` | `qoder-trace` 显式关闭时的 `chat_message.rowid` token fallback |

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

预期：`hooks.Stop` 数组里至少有一项以 nested 格式（外层 `matcher` + 内层 `hooks[]`）指向 `qoder-loongsuite-pilot-hook.sh`。

> Qoder **nested 格式**与 Cursor **flat 格式**不同，不要混。

#### 4.2 Hook 脚本 + processor 可执行

```bash
ls -l ~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh   # 需要 x 权限
ls -l ~/.loongsuite-pilot/hooks/qoder-hook-processor.mjs               # Qoder 专用（qoder-cn 共用同一份）
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
| `~/.qoder/settings.json` | Qoder 的共享 Stop hook 注册（nested 格式） |
| `~/.qoder/logs/sessions/<cwd>/<session>/segments/*.jsonl` | Qoder CLI 原生 transcript + token 事件（`qoder-trace` / `qoder-cli-session` 读取） |
| `~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh` | Qoder Hook shell 入口 |
| `~/.loongsuite-pilot/hooks/qoder-hook-processor.mjs` | Qoder 专用 transcript forwarder（从 stdin 拿 transcript_path，增量 append 到 history） |
| `~/.loongsuite-pilot/state/hooks/qoder-line-records/*.json` | processor 的 per-session 增量行记录状态（持久目录，部署升级不会覆盖） |
| `~/.loongsuite-pilot/state/hooks/qoder-line-records.json` | 旧版本回滚兼容影子（加锁更新，非当前主状态） |
| `~/.loongsuite-pilot/logs/qoder/history/qoder-YYYY-MM-DD.jsonl` | transcript 转发后的 history（`qoder-trace` / `qoder-cli-hook` 读取） |
| `~/.loongsuite-pilot/logs/qoder/debug/qoder-debug-*.log` | processor 调试日志 |
| `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` | Qoder IDE SQLite token 数据源 |
| `~/.qoder/shared_client/cache/db/local.db` | Qoder for JetBrains SQLite token 数据源（输出标记为 `qoder-idea`） |
| `~/.loongsuite-pilot/hooks/qodercli-token-intercept.mjs` | Qoder CLI token / system prompt preload 脚本 |
| `~/.loongsuite-pilot/logs/qodercli-intercept.jsonl` | qodercli preload 捕获的 token / system prompt fallback 数据 |
| `~/.loongsuite-pilot/logs/output/qoder-cli-YYYY-MM-DD.jsonl` | CLI 规范化输出 |
| `~/.loongsuite-pilot/logs/output/qoder-YYYY-MM-DD.jsonl` | IDE 规范化输出 |
| `~/.loongsuite-pilot/logs/input-state.json` | Qoder 相关 Input 的游标 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| **Qoder / Qoder CLI 完全无数据** | 先确认用户使用的是 Qoder 桌面版 / Qoder CLI，还是 IntelliJ IDEA 里的 Qoder for JetBrains 插件；JetBrains 场景直接阅读 `qoder-jetbrains-diagnostics.md`，桌面版/CLI 再继续本文档排查 |
| **Qoder CLI 完全无数据** | **首查 Qoder CLI 版本**。老版本不执行 `hooks.Stop`，也可能不写 session segments。升级到最新稳定版后 `loongsuite-pilot restart` |
| **Qoder IDE 完全无数据** | **首查 Qoder IDE 版本**。老版本缺 `ai_tracker/` 目录或 `chat_message.token_info` 字段。升级 Qoder 后重启 IDE |
| Qoder Work（`~/.qoderwork/`）用户问怎么排查 | Qoder Work 已独立支持，链路与本文档不同，直接阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoderwork-diagnostics.md` |
| **qodercli CLI token 全 0（session 有数据）** | `qodercli-token-intercept.mjs` 未注入或当前终端未 source rc，参考第 2.A.4 步 |
| **qodercli CLI 无 system prompt** | 同上，preload 未生效导致 `system_prompt` 未写入 `qodercli-intercept.jsonl` |
| `~/.loongsuite-pilot/logs/qodercli-intercept.jsonl` 不存在 | 注入块缺失或未 source rc；执行 `loongsuite-pilot restart` 修复后重新 source rc 或开新终端 |
