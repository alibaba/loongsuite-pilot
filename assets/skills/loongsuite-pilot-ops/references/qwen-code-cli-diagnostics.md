# Qwen Code CLI Hook 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qwen-code-cli-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Qwen Code CLI hook → transcript parser → JSONL → Input 消费链路**，不包含 Qwen Code CLI 自身功能问题。

---

## 采集链路概览

```
Qwen Code CLI
  └─ ~/.qwen/settings.json 注册 Stop / SubagentStart / SubagentStop hook
       └─ qwen-code-cli-loongsuite-pilot-hook.sh <kebab-case subcommand>
            └─ qwen-code-cli-hook-processor.mjs
                 ├─ Stop: 解析 transcript_path，写 event_t JSONL
                 └─ SubagentStart/SubagentStop: v1 仅写入 state，暂不直接发出事件
                      └─ ~/.loongsuite-pilot/logs/qwen-code-cli/qwen-code-cli-YYYY-MM-DD.jsonl
                           └─ QwenCodeCliLogInput (id=qwen-code-cli-log)
                                └─ 规范化输出到 ~/.loongsuite-pilot/logs/output/
```

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qwen/settings.json` 的 `hooks.{Stop,SubagentStart,SubagentStop}`（nested 格式） | pilot 启动时检测到 `~/.qwen/` 或 `qwen` 命令后自动注入 |
| Hook 脚本 | `~/.loongsuite-pilot/hooks/qwen-code-cli-loongsuite-pilot-hook.sh` | pilot 安装/升级时拷贝 |
| Hook processor | `~/.loongsuite-pilot/hooks/qwen-code-cli-hook-processor.mjs` | pilot 安装/升级时拷贝 |
| Processor state | `~/.loongsuite-pilot/hooks/qwen-code-cli/` 下的 session state | processor 写入 |
| 原始 JSONL | `~/.loongsuite-pilot/logs/qwen-code-cli/qwen-code-cli-YYYY-MM-DD.jsonl` | processor 写入 |
| Hook 错误日志 | `~/.loongsuite-pilot/logs/qwen-code-cli/errors/` | shared error logger 写入 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `qwen-code-cli-log` 条目 | QwenCodeCliLogInput 写入 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/` 中 `agentType=qwen-code-cli` 的记录 | Flusher 写出 |

---

## 系统化排查顺序

Qwen Code CLI 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → qwen 命令与 ~/.qwen/ 目录是否存在
第 2 步 → settings.json hook 是否注入 3 个事件
第 3 步 → 原始 JSONL 是否生成（Stop hook 是否解析 transcript）
第 4 步 → pilot 是否成功消费
第 5 步 → transcript_path / Node runtime / 错误日志定位
```

---

## 第 1 步：qwen 命令与配置目录

```bash
command -v qwen || true
ls -la ~/.qwen/
```

预期：`qwen` 命令可用或 `~/.qwen/` 目录存在。若目录不存在，让用户先启动一次 Qwen Code CLI 后执行：

```bash
~/.local/bin/loongsuite-pilot restart
```

---

## 第 2 步：settings.json hook 注册状态

```bash
python3 -m json.tool ~/.qwen/settings.json 2>/dev/null \
  | grep -c "qwen-code-cli-loongsuite-pilot-hook.sh\|qwen-code-cli-hook-processor"
```

预期输出：**3**，对应事件：

| Hook 事件 | 子命令 |
|-----------|--------|
| `Stop` | `stop` |
| `SubagentStart` | `subagent-start` |
| `SubagentStop` | `subagent-stop` |

若计数不为 3 或 settings.json 不存在 → `~/.local/bin/loongsuite-pilot restart` 重新注入。

> `eventSubcommand` 使用 `kebab-case`，所以 settings 中应看到 `subagent-start` / `subagent-stop`，不要写成 camelCase。

---

## 第 3 步：原始 JSONL 是否生成

```bash
ls -la ~/.loongsuite-pilot/logs/qwen-code-cli/
tail -20 ~/.loongsuite-pilot/logs/qwen-code-cli/qwen-code-cli-$(date +%Y-%m-%d).jsonl \
  | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({
        "event.name": r.get("event.name"),
        "gen_ai.session.id": r.get("gen_ai.session.id"),
        "gen_ai.agent.type": r.get("gen_ai.agent.type"),
        "gen_ai.tool.name": r.get("gen_ai.tool.name"),
        "has_input": "gen_ai.input.messages_delta" in r,
        "has_output": "gen_ai.output.messages" in r,
    })
'
```

预期：每行包含 `event.name`、`gen_ai.session.id`、`gen_ai.agent.type: "qwen-code-cli"`，常见事件为：

- `llm.request`
- `llm.response`
- `tool.call`
- `tool.result`

文件不存在 / 为空：

- 用户在 hook 注入后没有结束过一次完整对话（Stop 未触发）
- Stop payload 缺 `session_id` 或 `transcript_path`
- transcript 文件尚未稳定写入或不可读
- processor 报错 → 看第 5 步

---

## 第 4 步：pilot 是否成功消费

```bash
# 4.1 游标是否前进
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 3 '"qwen-code-cli-log"'

# 4.2 输出是否产出
ls -la ~/.loongsuite-pilot/logs/output/ | grep qwen-code-cli
tail -20 ~/.loongsuite-pilot/logs/output/qwen-code-cli-$(date +%Y-%m-%d).jsonl 2>/dev/null \
  | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({"event.name": r.get("event.name"), "agent": r.get("gen_ai.agent.type"), "session": r.get("gen_ai.session.id")})
'
```

预期：`qwen-code-cli-log` 有 `lastOffset`，output 中存在 `gen_ai.agent.type = "qwen-code-cli"` 的记录。

`lastOffset` 不前进的可能原因：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `qwen-code-cli-log` Input 被禁用 → 检查 `listeners["qwen-code-cli-log"]`
- 原始 JSONL 没有新增 → 回第 3 步

---

## 第 5 步：transcript_path / Node runtime / 错误日志定位

### 5.1 Hook 脚本和 processor 是否存在

```bash
ls -l ~/.loongsuite-pilot/hooks/qwen-code-cli-loongsuite-pilot-hook.sh
ls -l ~/.loongsuite-pilot/hooks/qwen-code-cli-hook-processor.mjs
```

缺失或无执行权限 → 安装/升级 assets 未正确拷贝，重跑安装或 `loongsuite-pilot restart`。

### 5.2 Node runtime

```bash
cat ~/.loongsuite-pilot/node-bin
"$(cat ~/.loongsuite-pilot/node-bin)" --version   # 应 >= v18
```

如果 hook 找不到 Node ≥ 18，会 fail-open，不阻塞 Qwen Code CLI，但不会产生日志。

### 5.3 错误日志

```bash
ls -la ~/.loongsuite-pilot/logs/qwen-code-cli/errors/ 2>/dev/null
tail -50 ~/.loongsuite-pilot/logs/qwen-code-cli/errors/*.log 2>/dev/null
```

常见错误关键字：

| 关键字 | 含义 |
|--------|------|
| `missing_session_id` | hook stdin 缺 `session_id`，processor 跳过 |
| `missing_transcript_path` | Stop 时没有拿到 transcript 路径 |
| `transcript_parse` / `parse_failed` | transcript JSONL 格式不符合 parser 预期 |
| `export_failed` | Stop 导出过程中异常，查看完整 stack |

### 5.4 session state

```bash
ls -la ~/.loongsuite-pilot/hooks/qwen-code-cli/ 2>/dev/null
```

如果 state 长期残留且 JSONL 不增长，说明 Stop 导出失败或 transcript offset 未推进。优先看错误日志，而不是直接删除 state。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qwen/settings.json` | Qwen Code CLI 的 3 个 hook 注册 |
| `~/.loongsuite-pilot/hooks/qwen-code-cli-loongsuite-pilot-hook.sh` | hook shell 入口 |
| `~/.loongsuite-pilot/hooks/qwen-code-cli-hook-processor.mjs` | transcript parser / event_t emitter |
| `~/.loongsuite-pilot/hooks/qwen-code-cli/` | processor session state |
| `~/.loongsuite-pilot/logs/qwen-code-cli/qwen-code-cli-YYYY-MM-DD.jsonl` | 原始 JSONL |
| `~/.loongsuite-pilot/logs/qwen-code-cli/errors/` | hook / processor 错误日志 |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `qwen-code-cli-log` 增量游标 |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| settings 中无 hook | `loongsuite-pilot restart` 重新注入 |
| settings 中事件名正确但无 JSONL | 完成一次完整对话并结束，确认 Stop hook 触发 |
| error 中 `missing_transcript_path` | Qwen Code CLI 版本未在 Stop payload 提供 transcript_path，升级 Qwen Code CLI |
| error 中 `parse_failed` | transcript 格式变化或损坏，保留错误日志和 transcript 片段排查 parser |
| JSONL 有数据但 output 无 | 检查 `qwen-code-cli-log` 游标、pilot 服务状态和 listener 启用状态 |
| SubagentStart/SubagentStop 没有单独事件 | 当前 v1 只把子 agent hook 累积到 state，Stop 导出时再使用；单独无 JSONL 属预期 |
