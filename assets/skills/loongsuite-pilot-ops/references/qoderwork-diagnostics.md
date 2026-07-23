# Qoder Work 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoderwork-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Qoder Work 的本地数据采集链路**，不包含 Qoder Work 自身的功能问题。
**本文档不覆盖 Qoder IDE / Qoder CLI** —— 那两个属于 Qoder 主产品，链路与 Qoder Work 完全不同，
排查请阅读 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-diagnostics.md`。

---

## 采集链路概览（Qoder Work 四链路，trace 默认接管）

Qoder Work 默认由 `qoder-work-trace` 聚合 Hook JSONL、session segments、SDK log 和 runtime wrapper intercept 数据；
`qoder-work-hook` / `qoder-work-log` / `qoder-work-sqlite` 是 **显式关闭 `qoder-work-trace` 后的 fallback**，默认不会启动。

```
Qoder Work
  ├─ Stop hook (~/.qoderwork/settings.json)
  │    └─ qoderwork-loongsuite-pilot-hook.sh
  │         └─ qoderwork-hook-processor.mjs --agent-id qoder-work
  │              └─ ~/.loongsuite-pilot/logs/qoder-work/history/qoder-work-YYYY-MM-DD.jsonl
  │                   └─ QoderWorkTraceInput (id=qoder-work-trace, 默认主链路)
  ├─ Session segments
  │    └─ ~/.qoderwork/logs/sessions/<session>/...
  │         └─ qoder-work-trace 用于 LLM / tool timing 与 token enrichment
  ├─ SDK log tail
  │    └─ QoderWork 应用 logs 目录
  │         └─ qoder-work-trace 兼容历史 token 数据；trace 关闭时 `qoder-work-log` fallback 才启动
  └─ SQLite agents.db
       └─ QoderWork data/agents.db
            └─ trace 关闭时 `qoder-work-sqlite` fallback 才启动
```

任一输入源缺失都可能导致字段不完整；默认生产路径下应先排查 `qoder-work-trace`，不要只看 `qoder-work-hook`。

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qoderwork/settings.json` 的 `hooks.Stop`（nested 格式） | pilot 启动时检测到 `~/.qoderwork/` 存在自动注入 |
| Hook 脚本 | `~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh` | pilot 安装/升级时拷贝 |
| Hook processor | `~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs` | pilot 安装/升级时拷贝 |
| Processor 游标 | `~/.loongsuite-pilot/state/hooks/qoder-work-line-records/*.json` | 每个 session 一个状态文件；processor 成功 append 后更新，部署升级不会覆盖 |
| History JSONL | `~/.loongsuite-pilot/logs/qoder-work/history/qoder-work-YYYY-MM-DD.jsonl` | processor 增量 append，`qoder-work-trace` 默认读取 |
| Session segments | `~/.qoderwork/logs/sessions/` | Qoder Work 应用自身写入，`qoder-work-trace` 用于 token/timing enrichment |
| SDK log | Qoder Work 应用 logs 目录 | Qoder Work 应用自身写入，trace 关闭时 `qoder-work-log` fallback 才单独启动 |
| SQLite DB | Qoder Work `data/agents.db` | Qoder Work 应用自身写入，trace 关闭时 `qoder-work-sqlite` fallback 才单独启动 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `qoder-work-trace` / fallback 条目 | 对应 Input 每次成功 flush 后更新 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/qoder-work-YYYY-MM-DD.jsonl` | Flusher 写出 |

---

## 系统化排查顺序

Qoder Work 数据未出现时，**按以下顺序逐步排查，勿跳步**——后一步的结论依赖前一步：

```
第 1 步 → ~/.qoderwork/ 目录是否存在 + hook 是否注入
第 2 步 → 原始 history JSONL 是否生成（hook 是否被触发）
第 3 步 → 依赖注入校验（QODER_WORKER_RUNTIME_PATH token wrapper）
第 4 步 → pilot 是否成功消费（input-state 推进 + output 产出）
第 5 步 → 配置文件 / Node runtime 对照检查
```

---

## 第 1 步：目录存在性 + Hook 注册状态

### 1.1 `~/.qoderwork/` 目录

pilot 启动时通过检测 `~/.qoderwork/` 目录是否存在来判定是否要注册 Qoder Work 的 hook 并启动相关采集链路。
若目录不存在，pilot 不会注入 hook，也不会启动 `qoder-work-trace` 或 fallback Input：

```bash
ls -la ~/.qoderwork/
```

预期：能看到 `settings.json` 及其它配置。若目录不存在 → 用户从未启动过 Qoder Work，
让用户先启动一次 Qoder Work 后 `~/.local/bin/loongsuite-pilot restart`。

### 1.2 settings.json 的 Stop hook

pilot 把 hook 注入 `~/.qoderwork/settings.json` 的 `hooks.Stop`，**nested 格式**：

```bash
python3 -m json.tool ~/.qoderwork/settings.json \
  | grep -c "qoderwork-loongsuite-pilot-hook.sh\|qoder-loongsuite-pilot-hook.sh qoder-work"
```

预期输出：**1**。对应的 settings.json 片段：

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "command": "/Users/<you>/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh", "type": "command" }
        ]
      }
    ]
  }
}
```

> Qoder Work 与 Qoder CLI 一样使用 **nested 格式**（外层 `matcher` + 内层 `hooks[]`），
> 不要与 Cursor 的 **flat 格式**混淆。

若 hook 缺失 → `~/.local/bin/loongsuite-pilot restart`（注入幂等，不会重复写）。
若现存 hook 仍指向旧入口 `qoder-loongsuite-pilot-hook.sh qoder-work`（兼容旧版），
restart 时会被自动替换为新的 `qoderwork-loongsuite-pilot-hook.sh`。

> Qoder Work 只注入 `Stop` 一个事件，由 `qoderwork-hook-processor.mjs` 根据 `transcript_path`
> 增量拉取 transcript，**不需要**也**不会**像 Codex 那样注入 5 个事件。

---

## 第 2 步：检查原始 history JSONL（hook 是否被触发）

Stop hook 触发后，`qoderwork-hook-processor.mjs` 把 Qoder Work 的 transcript 新增行增量
append 到 history JSONL：

```bash
ls -la ~/.loongsuite-pilot/logs/qoder-work/history/
tail -2 ~/.loongsuite-pilot/logs/qoder-work/history/qoder-work-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

预期：
- 文件名严格为 `qoder-work-YYYY-MM-DD.jsonl`（agent-id 决定，固定写死）
- 每行是一条 JSON 记录，含以下任一形态：
  - **canonical hook 记录**：带 `event.name` / `gen_ai.agent.type: "qoder-work"` / `agent.source: "qoder-transcript-hook"`
  - **PostToolUse 记录**：`event_type: "PostToolUse"` + `tool_input.file_path`（文件编辑事件，pilot 据 `loongsuite_pilot_pre_file_exists` 区分 Create / Edit）
  - **assistant/user transcript 行**：`type: "assistant"` 或 `type: "user"`，含 `message.content`

processor 的增量状态保存在：

```bash
ls -la ~/.loongsuite-pilot/state/hooks/qoder-work-line-records/
cat ~/.loongsuite-pilot/state/hooks/qoder-work-line-records/*.json
# 每个文件对应一个 session，内容含 session_id、transcript_path、last_line_count、updated_at
```

同目录下的 `qoder-work-line-records.json` 是加锁维护的旧版本回滚兼容影子；当前版本以
`qoder-work-line-records/*.json` 为主状态，排障时不要把两者混为同一个游标文件。

若 history 目录**不存在**或**完全为空**：

- 用户在 hook 注入之后**从未触发过 Stop**（没结束过对话）→ 让用户在 Qoder Work
  里发一句完整对话后再看
- hook 被触发但 stdin 缺 `transcript_path` 或 `session_id` → 看 debug 日志：
  ```bash
  ls ~/.loongsuite-pilot/logs/qoder-work/debug/
  tail -50 ~/.loongsuite-pilot/logs/qoder-work/debug/qoder-work-debug-$(date -u +%Y-%m-%d).log
  ```
  常见日志关键字：`No transcript_path or session_id`、`Transcript file not found`、`No new lines`
- hook 进程本身报错 → 看错误日志：
  ```bash
  tail -50 ~/.loongsuite-pilot/logs/qoder-work/errors/qoder-work-error-$(date -u +%Y-%m-%d).log
  ```

### 2.1 Hook 脚本可执行

```bash
ls -l ~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh   # 需要 x 权限
ls -l ~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs                # Qoder Work 专用 processor
```

若 hook 脚本无 x 权限 → `chmod +x ~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh`，
或直接 `~/.local/bin/loongsuite-pilot restart`（重装时会修复权限）。

### 2.2 Node runtime 是否可用

`qoderwork-loongsuite-pilot-hook.sh` 启动 processor 前会按 pin → nvm → volta → fnm →
homebrew → /usr/local → ~/.local → PATH 顺序探测 Node（要求 ≥ v18）：

```bash
cat ~/.loongsuite-pilot/node-bin                           # pin 文件
"$(cat ~/.loongsuite-pilot/node-bin)" --version            # 应 >= v18
```

若 pin 失效，会回退到全局 fallback；若 fallback 也都没有，hook 会输出
`[loongsuite-pilot] node >= 18 not found` 到 stderr 后 `exit 0`（fail-open，不阻塞 Qoder Work）。

---

## 第 3 步：依赖注入校验（QODER_WORKER_RUNTIME_PATH token wrapper）

Qoder Work 的 token fallback 采集依赖 `qoderwork-runtime-wrapper.mjs`。它通过 macOS `launchctl setenv QODER_WORKER_RUNTIME_PATH=...`
注入到 GUI 启动的 QoderWork 进程中，再在 worker runtime 内拦截 `JSON.parse` 写出 token / system prompt。
缺失时常见表现是 **history / output 都有 Chat / Tool call，但 token 全 0、cache_read 缺失或 system prompt 缺失**。

> 该注入目前仅适用于 macOS QoderWork App。Linux / Windows 环境下跳过本步骤。

```bash
# 1) wrapper 文件必须存在
ls -l ~/.loongsuite-pilot/hooks/qoderwork-runtime-wrapper.mjs

# 2) 当前 launchd 会话中的环境变量必须指向 wrapper
launchctl getenv QODER_WORKER_RUNTIME_PATH

# 3) 重启后自动恢复的 LaunchAgent 必须存在并包含相同路径
ls -l ~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist
grep -n 'QODER_WORKER_RUNTIME_PATH\|qoderwork-runtime-wrapper.mjs' \
  ~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist
```

预期：`launchctl getenv QODER_WORKER_RUNTIME_PATH` 输出
`/Users/<you>/.loongsuite-pilot/hooks/qoderwork-runtime-wrapper.mjs`，plist 中也包含同一路径。

若不一致或为空：

```bash
~/.local/bin/loongsuite-pilot restart
launchctl getenv QODER_WORKER_RUNTIME_PATH
```

修复后必须**完全退出并重新打开 QoderWork**，否则旧 GUI 进程不会继承新的 launchd 环境。

完成一次 Qoder Work 对话后验证 wrapper 输出：

```bash
ls -l ~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl
tail -20 ~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl | python3 -c '
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

预期能看到 `type: "token"` 或 `type: "system_prompt"` 记录。若文件不存在但 QoderWork 正常运行：

```bash
tail -50 ~/.loongsuite-pilot/logs/qoderwork-wrapper-error.log 2>/dev/null
```

若 error 日志提示 `real runtime not found`，说明 wrapper 已注入，但未找到 QoderWork 内置 worker runtime。常见原因是 QoderWork 安装路径或 SDK 版本结构变化，
需升级 pilot 或补充 wrapper 的 runtime candidate。

---

## 第 4 步：pilot 是否成功消费

QoderWorkTraceInput（id 为 `qoder-work-trace`）按 `pollInterval`（默认 30s）轮询 history、session segments 与本地数据源，
把新增行规范化后交给 Flusher 写到 output：

```bash
# 4.1 input-state 中的 qoder-work-trace 游标（默认主链路）
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool \
  | grep -A 5 '"qoder-work-trace"'

# 4.2 如果显式关闭了 trace，再检查 fallback 游标
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool \
  | grep -E -A 3 '"qoder-work(-hook|-log|-sqlite)?"'

# 4.3 pilot 输出（只投影元数据，避免打印 prompt/tool 内容）
ls -la ~/.loongsuite-pilot/logs/output/ | grep qoder-work
tail -20 ~/.loongsuite-pilot/logs/output/qoder-work-$(date -u +%Y-%m-%d).jsonl 2>/dev/null \
  | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({"event.name": r.get("event.name"), "agent": r.get("gen_ai.agent.type"), "session": r.get("gen_ai.session.id")})
'
```

预期：
- 默认情况下 `input-state.json` 中存在 `qoder-work-trace` 条目，`lastFile` 指向当天的
  `qoder-work-YYYY-MM-DD.jsonl`，`lastOffset` 数值持续增大
- output 目录产出 `qoder-work-YYYY-MM-DD.jsonl`，与第 2 步原始日志的记录数大致对齐
- 每行 `gen_ai.agent.type` 为 `qoder-work`

`lastOffset` 不前进的可能原因：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `qoder-work-trace` Input 未注册 → `tail ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`，搜 `qoder-work-trace` 关键字
- `qoder-work-trace` 被显式禁用 → 再检查 `qoder-work-hook` / `qoder-work-log` / `qoder-work-sqlite` fallback
- 原始 history 确实没新增（第 2 步的源为空）→ 回第 2 步
- 配置里关掉了 `qoder-work` → 见第 5 步配置检查

---

## 第 5 步：配置文件对照检查

### 5.1 pilot 的 listener 是否启用

```bash
python3 - <<'PY'
import json
import pathlib
path = pathlib.Path.home() / '.loongsuite-pilot' / 'config.json'
try:
    cfg = json.loads(path.read_text())
except Exception:
    print('config.json 不存在或无法解析；使用默认 listener 配置')
    raise SystemExit(0)
listeners = cfg.get('listeners') or {}
for key in ('qoder-work-trace', 'qoder-work', 'qoder-work-log', 'qoder-work-sqlite'):
    item = listeners.get(key) or {}
    print(key, {
        'enabled': item.get('enabled', 'default'),
        'pollInterval': item.get('pollInterval', 'default'),
    })
PY
```

预期：`qoder-work-trace.enabled` 未配置或为 `true`（默认主链路）。如果它显式为 `false`，再确认 fallback 中至少一个需要的 Input 未被禁用。

若相关 `enabled: false` 导致采集关闭，可通过 pilot 的 agent 控制 API 临时启用：

```bash
~/.local/bin/loongsuite-pilot agent enable qoder-work
~/.local/bin/loongsuite-pilot restart
```

### 5.2 `~/.qoderwork/settings.json` 是否被 Qoder Work 覆盖

Qoder Work 自身升级或重置配置时，可能把 pilot 注入的 hook 配置清掉：

```bash
python3 -m json.tool ~/.qoderwork/settings.json | grep -A 8 '"Stop"'
```

预期：`hooks.Stop` 数组里至少有一项以 nested 格式指向
`qoderwork-loongsuite-pilot-hook.sh`。若缺失：

```bash
~/.local/bin/loongsuite-pilot restart       # 重新检测 + 注入（幂等）
```

### 5.3 数据根目录是否被环境覆盖

QoderWorkInput 默认从 `~/.loongsuite-pilot/logs/qoder-work/history/` 读取。
若用户设置了 `LOONGSUITE_PILOT_DATA_DIR` 等环境变量，pilot 服务进程与 hook
脚本看到的值必须一致：

```bash
~/.local/bin/loongsuite-pilot status      # 查看 pilot 服务的启动环境
env | grep LOONGSUITE_PILOT
```

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qoderwork/settings.json` | Qoder Work 的 hook 注册（`hooks.Stop`，nested 格式） |
| `~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh` | Qoder Work 专用的 shell 入口（pilot 维护） |
| `~/.loongsuite-pilot/hooks/qoderwork-hook-processor.mjs` | Qoder Work 专用 transcript forwarder（从 stdin 拿 `transcript_path`，增量 append 到 history） |
| `~/.loongsuite-pilot/state/hooks/qoder-work-line-records/*.json` | processor 的 per-session 增量行记录状态（持久目录） |
| `~/.loongsuite-pilot/state/hooks/qoder-work-line-records.json` | 旧版本回滚兼容影子（加锁更新，非当前主状态） |
| `~/.loongsuite-pilot/logs/qoder-work/history/qoder-work-YYYY-MM-DD.jsonl` | transcript 转发后的 history（`qoder-work-trace` 默认读取；trace 关闭时 `qoder-work-hook` fallback 读取） |
| `~/.loongsuite-pilot/logs/qoder-work/debug/qoder-work-debug-*.log` | processor 调试日志 |
| `~/.loongsuite-pilot/logs/qoder-work/errors/qoder-work-error-*.log` | processor 错误日志（fail-open，不阻塞 Qoder Work） |
| `~/.loongsuite-pilot/logs/output/qoder-work-YYYY-MM-DD.jsonl` | 规范化输出 |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `qoder-work-trace` 及 fallback Input 的游标 |
| `~/.loongsuite-pilot/node-bin` | Node runtime pin 文件（与 Qoder CLI / Cursor 共用） |
| `~/.loongsuite-pilot/hooks/qoderwork-runtime-wrapper.mjs` | Qoder Work token fallback 运行时 wrapper（macOS 通过 `QODER_WORKER_RUNTIME_PATH` 注入） |
| `~/Library/LaunchAgents/com.loongsuite-pilot.qoderwork-env.plist` | 重启后自动恢复 `QODER_WORKER_RUNTIME_PATH` 的 LaunchAgent |
| `~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl` | wrapper 捕获的 token / system prompt fallback 数据 |
| `~/.loongsuite-pilot/logs/qoderwork-wrapper-error.log` | wrapper 找不到真实 runtime 或 import 失败时的诊断日志 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| **Qoder Work 完全无数据** | 先确认 `~/.qoderwork/` 存在（用户至少启动过一次 Qoder Work），再 `loongsuite-pilot restart` 让 pilot 注入 hook |
| `~/.qoderwork/settings.json` 中无 Stop hook | `loongsuite-pilot restart`，注入是幂等的 |
| Stop hook 指向旧入口 `qoder-loongsuite-pilot-hook.sh qoder-work` | `loongsuite-pilot restart` 会自动替换为新入口 `qoderwork-loongsuite-pilot-hook.sh` |
| history 目录为空但 hook 已注入 | 用户在注入后还没结束过一次完整对话（Stop hook 未触发）。让用户在 Qoder Work 里发一句完整对话再看 |
| debug 日志里只有 `No transcript_path or session_id` | Qoder Work 版本过老，Stop hook payload 里没有 `transcript_path`。让用户升级 Qoder Work |
| debug 日志里反复 `Transcript file not found` | Qoder Work 写 transcript 的实际路径与 stdin 提供的 `transcript_path` 不一致；通常是 Qoder Work 自身的 bug，让用户升级 Qoder Work |
| history 有数据但 output 没有 | 默认先看 `input-state.json` 里 `qoder-work-trace` 的 `lastFile` / `lastOffset` 是否前进；不前进则查 `loongsuite-pilot-service.log` 中 `qoder-work-trace` 关键字 |
| `[loongsuite-pilot] node >= 18 not found` | 系统找不到合适的 Node。装一个 Node ≥ 18 并写入 `~/.loongsuite-pilot/node-bin` |
| Qoder Work token 全 0 / cache_read 缺失，但 Chat / Tool call 正常 | macOS 上优先检查第 3 步 `QODER_WORKER_RUNTIME_PATH` 是否注入，修复后必须完全退出并重新打开 QoderWork |
| `~/.loongsuite-pilot/logs/qoderwork-intercept.jsonl` 不存在 | wrapper 未注入、QoderWork 未重启继承 env，或真实 runtime 未找到；查看 `qoderwork-wrapper-error.log` |
| `qoderwork-wrapper-error.log` 提示 `real runtime not found` | QoderWork 安装路径或 SDK 版本结构变化，wrapper 已加载但找不到真实 worker runtime，需要升级 pilot 或补充 runtime candidate |
| hook 脚本无执行权限 | `chmod +x ~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh`，或 `loongsuite-pilot restart` 重装 |
| 同时使用 Qoder CLI 和 Qoder Work，数据混在一起 | 不会混。两边走完全独立的 settings.json（`~/.qoder/` vs `~/.qoderwork/`）、独立的 hook 脚本、独立的 history 目录和独立的 Input；最终在 output 中通过 `gen_ai.agent.type` 区分（`qoder` vs `qoder-work`） |
