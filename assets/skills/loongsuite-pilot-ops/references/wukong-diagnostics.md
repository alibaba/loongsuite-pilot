# Wukong CLI API Polling 诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/wukong-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Wukong 的 CLI API 轮询采集链路**，不包含 Wukong 自身的功能问题。
Wukong 与其它 agent 完全不同：**没有 hook、没有 JSONL 落盘、没有 SQLite**，pilot 直接通过
`wukong-cli` 命令轮询 Wukong 本地守护进程获取任务和消息数据。

---

## 采集链路概览

```
Wukong 守护进程
  └─ ~/.real/daemon.sock（unix socket，进程存活标志）
       └─ WukongInput.checkAvailability() 检测 socket 存在 + wukong-cli service status 为 running
            └─ WukongInput.onStart() 基线：wukong-cli agent data list_tasks 获取全部任务
                 → 对每个 task 调 wukong-cli agent data get_spark_agui_messages 记录已见消息数
            └─ 定时轮询（默认 60s）：
                 wukong-cli agent data list_tasks
                   → 对比 seenCounts，只处理有新消息的任务
                      → wukong-cli agent data get_spark_agui_messages
                           → 规范化为 AgentActivityEntry
                                → Flusher → SLS / JSONL / HTTP
```

| 关键组件 | 路径 / 命令 | 说明 |
|---|---|---|
| 守护进程存活标志 | `~/.real/daemon.sock` | Wukong 客户端启动后创建，socket 不存在 = 未运行 |
| CLI 可执行文件（macOS） | `/Applications/Wukong.app/Contents/MacOS/wukong-cli` | 固定路径，不依赖 PATH |
| CLI 可执行文件（其他平台） | `wukong-cli`（需在 PATH 中） | 依赖 PATH 查找 |
| 服务状态命令 | `wukong-cli service status` | 输出需匹配 `/running/i` |
| 任务列表命令 | `wukong-cli agent data list_tasks --json '{...}'` | 分页返回 `items` + `hasMore` + `nextCursor` |
| 消息列表命令 | `wukong-cli agent data get_spark_agui_messages --json '{"conversationId":"..."}'` | 返回 `messages` 数组 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `wukong` 条目 | `extra.seenCounts`：`session_id → 已处理消息数` |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/` 中 `agentType=wukong` 的记录 | Flusher 写出 |

---

## 系统化排查顺序

Wukong 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → 守护进程是否存活 + wukong-cli 是否可执行
第 2 步 → list_tasks / get_spark_agui_messages 手动验证
第 3 步 → pilot 游标 baseline 与 seenCounts 检查
第 4 步 → pilot 是否成功消费
第 5 步 → 并发 / 超时 / 分页异常定位
```

---

## 第 1 步：守护进程是否存活 + CLI 可执行

### 1.1 daemon socket

```bash
ls -la ~/.real/daemon.sock
```

不存在 → Wukong 客户端未运行，`checkAvailability()` 直接返回 false，Input 不会启动。让用户先启动 Wukong。

### 1.2 wukong-cli 可执行 + 服务状态

```bash
# macOS 固定路径
WUKONG_CLI="/Applications/Wukong.app/Contents/MacOS/wukong-cli"
# 其他平台
command -v wukong-cli || true

"$WUKONG_CLI" service status   # 或 wukong-cli service status
```

预期输出中包含 `running`（大小写不敏感）。若报错或输出不含 `running`：

- Wukong 客户端已崩溃或正在重启
- CLI 二进制路径不对（macOS 上必须是 App Bundle 内路径，其他平台必须在 PATH 中）

---

## 第 2 步：list_tasks / get_spark_agui_messages 手动验证

### 2.1 任务列表

```bash
"$WUKONG_CLI" agent data list_tasks --json '{"limit":50}'
```

预期：JSON 输出中 `items` 为数组，每项含 `id` / `session_id` / `status` / `agent_type` 等字段。

- 若 `session_id` 为 `null`，该任务会被 pilot 过滤，不进入采集
- 若命令超时（10s）或返回非 JSON，检查 Wukong 客户端本身是否响应异常

### 2.2 单个任务的消息

默认不要打印完整 `content` / tool payload；只查看计数、ID、role、turnIndex 与 event 数量：

```bash
"$WUKONG_CLI" agent data get_spark_agui_messages --json '{"conversationId":"<session_id>"}' \
  | python3 -c '
import json, sys
m = json.load(sys.stdin).get("messages", [])
print("message_count", len(m))
for x in m[-5:]:
    print({
        "id": x.get("id"),
        "role": x.get("role"),
        "turnIndex": x.get("turnIndex"),
        "createdAt": x.get("createdAt"),
        "event_count": len(x.get("events") or []),
        "has_content": bool(x.get("content")),
    })
'
```

预期：`message_count` > 0，最近消息含 `id` / `role` / `turnIndex`。若返回空但用户确实和该会话有交互，检查 `conversationId` 是否与 `list_tasks` 返回的 `session_id` 完全一致。

只有在用户明确要求并确认可暴露内容时，才查看完整消息正文。

---

## 第 3 步：pilot 游标 baseline 与 seenCounts 检查

```bash
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 20 '"wukong"'
```

预期：`extra.seenCounts` 是一个对象，key 为 `session_id`，value 为已处理的消息数。

### 3.1 首次启动基线

pilot 首次启动 Wukong Input 时，会对所有任务并发（`BASELINE_CONCURRENCY=5`）调用一次
`get_spark_agui_messages`，把当前消息数记为基线——**只采基线之后新增的消息**：

```bash
grep '"tag":"WukongInput"\|baseline complete' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

预期看到 `baseline complete`，附带 `total` 和 `baselined` 数量。若 `baselined` 远小于 `total`，
说明部分任务在基线阶段调用失败（网络/超时），这些任务的 `seenCounts` 会被置 0（视为全部未见，
下次轮询可能产生大量补采）。

### 3.2 重置基线

若需要重新采集某个 session（例如怀疑基线计数错误），先让用户确认可以短暂停服，然后备份并原子替换 state 文件：

```bash
~/.local/bin/loongsuite-pilot stop
STATE="$HOME/.loongsuite-pilot/logs/input-state.json"
cp "$STATE" "$STATE.bak.$(date +%Y%m%d-%H%M%S)"
python3 - "$STATE" "<session_id>" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
session_id = sys.argv[2]
state = json.loads(path.read_text())
seen = state.get('wukong', {}).get('extra', {}).get('seenCounts', {})
if isinstance(seen, dict):
    seen.pop(session_id, None)
tmp = path.with_suffix(path.suffix + '.tmp')
tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
os.replace(tmp, path)
PY
~/.local/bin/loongsuite-pilot start
```

---

## 第 4 步：pilot 是否成功消费

```bash
ls -la ~/.loongsuite-pilot/logs/output/ | grep wukong
tail -20 ~/.loongsuite-pilot/logs/output/wukong-$(date -u +%Y-%m-%d).jsonl 2>/dev/null \
  | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({"event.name": r.get("event.name"), "agent": r.get("gen_ai.agent.type") or r.get("service.name"), "session": r.get("gen_ai.session.id")})
'
```

预期：output 中存在 `service.name: "wukong"` 或 `gen_ai.agent.type: "wukong"` 的记录。

若 output 无产出：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `wukong` Input 未注册/被禁用 → 检查 `listeners["wukong"]`，或搜索服务日志 `wukong`
- 轮询周期较长（默认 60s），刚产生的新消息需要等到下一轮询

---

## 第 5 步：并发 / 超时 / 分页异常定位

### 5.1 collect 周期超时

```bash
grep 'skip collect: previous cycle still running\|collect cycle exceeded poll interval' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

- `skip collect` → 上一轮 collect 还没结束，本轮跳过（通常是任务量大或 CLI 响应慢）
- `collect cycle exceeded poll interval` → 单轮耗时超过轮询间隔，需要关注 Wukong CLI 响应时间

### 5.2 分页截断

```bash
grep 'wukong task pagination truncated by MAX_TASKS' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -5
```

命中说明任务总数超过硬编码上限（500），超出部分本轮不会被采集，下一轮仍会按 `hasMore`/`nextCursor` 继续。

### 5.3 单任务处理失败

```bash
grep '"tag":"WukongInput".*failed to process task' \
  ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -10
```

单个任务失败不影响其余任务的采集（`Promise.allSettled` 隔离），但会导致该任务下一轮重试。

---

## 关键文件速查

| 文件 / 目录 / 命令 | 作用 |
|---|---|
| `~/.real/daemon.sock` | Wukong 守护进程存活标志 |
| `/Applications/Wukong.app/Contents/MacOS/wukong-cli`（macOS） | Wukong CLI 固定路径 |
| `wukong-cli`（其他平台，需在 PATH） | Wukong CLI |
| `wukong-cli service status` | 服务健康检查 |
| `wukong-cli agent data list_tasks --json '{...}'` | 任务分页列表 |
| `wukong-cli agent data get_spark_agui_messages --json '{...}'` | 单任务消息列表 |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `wukong` 的 `extra.seenCounts` |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出 |
| `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` | 搜索 `WukongInput` / `wukong` 关键字 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| Wukong 完全无数据 | 先确认 `~/.real/daemon.sock` 存在且 `wukong-cli service status` 为 running |
| `checkAvailability` 始终 false | 检查 CLI 路径（macOS 必须是 App Bundle 内路径）与 socket 是否存在 |
| `list_tasks` 返回非 JSON 或超时 | Wukong 客户端异常，重启 Wukong 客户端后重试 |
| 任务有 session_id 但消息数始终不增 | 检查 `get_spark_agui_messages` 手动调用是否有新消息；若有但 pilot 未采到，看 `seenCounts` 是否卡在旧值 |
| `baseline complete` 中 `baselined` 远小于 `total` | 基线阶段部分任务调用失败，会被视为 0，可能导致下次轮询补采较多历史消息 |
| `skip collect: previous cycle still running` 频繁出现 | Wukong 任务量大或 CLI 响应慢，考虑增大 `pollIntervalMs`（默认 60000ms） |
| `wukong task pagination truncated by MAX_TASKS` | 任务总数超过 500 上限，超出部分延后到下一轮采集，属设计行为 |
| output 中无 `wukong` 记录但游标在前进 | 检查 Flusher 配置（SLS/JSONL/HTTP）是否正常，参考 `service-diagnostics.md` 第 3 步 |
