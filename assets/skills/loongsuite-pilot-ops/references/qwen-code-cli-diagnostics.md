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
                 ├─ Stop: 解析主 transcript 和前台子 transcript/meta，写完整 turn JSONL
                 └─ SubagentStart/SubagentStop: 只确认 Hook，不并发修改父会话 state
                      └─ ~/.loongsuite-pilot/logs/qwen-code-cli/qwen-code-cli-YYYY-MM-DD.jsonl
                           └─ QwenCodeCliLogInput (id=qwen-code-cli-log)
                                └─ 规范化输出到 ~/.loongsuite-pilot/logs/output/
```

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qwen/settings.json` 的 `hooks.{Stop,SubagentStart,SubagentStop}`（nested 格式） | pilot 启动时检测到 `~/.qwen/` 或 `qwen` 命令后自动注入 |
| Hook 脚本 | `~/.loongsuite-pilot/hooks/qwen-code-cli-loongsuite-pilot-hook.sh` | pilot 安装/升级时拷贝 |
| Hook processor | `~/.loongsuite-pilot/hooks/qwen-code-cli-hook-processor.mjs` | pilot 安装/升级时拷贝 |
| Processor state | `~/.loongsuite-pilot/state/qwen-code-cli/sessions/` | processor 写入 |
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
ls -la ~/.loongsuite-pilot/state/qwen-code-cli/sessions/ 2>/dev/null
```

如果 state 长期残留且 JSONL 不增长，说明 Stop 导出失败或 transcript offset 未推进。优先看错误日志，而不是直接删除 state。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.qwen/settings.json` | Qwen Code CLI 的 3 个 hook 注册 |
| `~/.loongsuite-pilot/hooks/qwen-code-cli-loongsuite-pilot-hook.sh` | hook shell 入口 |
| `~/.loongsuite-pilot/hooks/qwen-code-cli-hook-processor.mjs` | transcript parser / event_t emitter |
| `~/.loongsuite-pilot/state/qwen-code-cli/sessions/` | processor session state |
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
| SubagentStart/SubagentStop 没有单独事件 | 子 Hook 只确认；父 Stop 从独立 transcript/meta 读取前台子执行，单独无 JSONL 属预期 |


## 前台子 Agent 数据缺失

主会话路径为 `<projectDir>/chats/<sessionId>.jsonl` 时，processor 会读取同项目的
`subagents/<sessionId>/agent-<agentId>.meta.json` 和对应 `.jsonl`。
通过 metadata 的 `parentAgentId` 和 `toolUseId` 关联各层父工具，并递归输出同一 Trace。
`SubagentStop.agent_transcript_path` 在部分上游版本可能指向父文件，不能据此判断子文件不存在。

检查父 `agent` 工具事件上的 `agent.qwen-code-cli.subagent.collection`：

| 值 | 含义 / 排查方向 |
|---|---|
| `collected` | 已采集该前台子执行 |
| `unsupported_background` | 后台内部过程不在当前支持范围；父启动工具仍采集 |
| `metadata_unavailable` / `metadata_missing` | 目录不可读、布局不支持或缺少匹配 metadata；检查 Qwen 实际版本及文件访问权限 |
| `ambiguous_parent` / `invalid_hierarchy` | 多个子执行声明同一父调用，或层级循环/超限；不猜测关联 |
| `unknown_execution_mode` | metadata 缺少明确的 `isBackgrounded` 前台标记 |
| `incomplete` | 未见父工具结果/子终态，或子文件仍变化、末尾半行 |
| `transcript_unavailable` / `no_model_records` | 子文件缺失、格式/身份不匹配，或当前调用时间范围内没有可解析模型轮次 |
| `collection_limit` | 超过每次扫描 1000 个 metadata、累计读取 50 MiB 或其他安全限制 |

子事件携带 `gen_ai.agent.scope=subagent`、`gen_ai.agent.depth`、`gen_ai.agent.parent.id`
及 `gen_ai.subagent.parent_tool_call.id`；子生命周期保留在
`agent.qwen-code-cli.subagent.status`。子消息与工具 payload 沿用内容采集开关和脱敏。
子工具 ID 按 Agent/run 做隔离，避免并行或多层复用原生 ID 时串链。

当前为父 Stop 边界的前台快照采集：不会等待后台执行，也不会向已经结束的 turn 补挂迟到子数据。
子文件暂不可读时保留父工具并标记采集不完整，不声称子数据已完整采集。
主文件末尾半行则保留原 offset，等待后续 Stop 重试。容器需要让 Stop Hook 完成，
并在销毁前让 Pilot 输出队列排空，或持久化 Pilot 日志供后续消费。

兼容性依据是上游 Qwen `v0.21.1` 的独立 transcript/meta 格式。
不同包名或私有 preview 不能仅按版本字符串视为同一实现；应核实上述字段。
