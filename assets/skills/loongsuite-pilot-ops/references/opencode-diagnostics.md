# OpenCode 插件注入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/opencode-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 OpenCode plugin injection → JSONL → Input 消费链路**，不包含 OpenCode 自身功能问题。
OpenCode 不是 shell hook 入口，而是将 `file://$PILOT_DATA/plugins/opencode/plugin.mjs` 注入到 OpenCode 配置中。

---

## 采集链路概览

```
OpenCode 启动
  └─ 读取 ~/.config/opencode/opencode.jsonc / opencode.json / config.json
       └─ plugins 包含 file://~/.loongsuite-pilot/plugins/opencode/plugin.mjs
            └─ plugin.mjs 监听 chat.message / message.updated / tool.execute.* 等事件
                 └─ append 到 ~/.loongsuite-pilot/logs/opencode/opencode-YYYY-MM-DD.jsonl
                      └─ OpenCodeLogInput (id=opencode-log, agentType=opencode)
                           └─ 规范化输出到 ~/.loongsuite-pilot/logs/output/
```

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| OpenCode 配置 | `~/.config/opencode/opencode.jsonc` / `opencode.json` / `config.json` | pilot 通过 plugin injection 修改 |
| 插件文件 | `~/.loongsuite-pilot/plugins/opencode/plugin.mjs` | pilot 安装/升级时拷贝 |
| 原始 JSONL | `~/.loongsuite-pilot/logs/opencode/opencode-YYYY-MM-DD.jsonl` | OpenCode 进程内的 plugin.mjs 写入 |
| 插件错误日志 | `~/.loongsuite-pilot/logs/opencode/opencode-error-YYYY-MM-DD.log` | plugin.mjs 写入 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `opencode-log` 条目 | OpenCodeLogInput 写入 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/` 中 `agentType=opencode` 的记录 | Flusher 写出 |

---

## 系统化排查顺序

OpenCode 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → OpenCode 是否安装/启动过 + 配置文件是否存在
第 2 步 → plugin injection 是否写入配置
第 3 步 → 原始 JSONL 是否生成
第 4 步 → pilot 是否成功消费
第 5 步 → 插件错误与配置冲突定位
```

---

## 第 1 步：OpenCode 安装与配置目录

```bash
command -v opencode || true
ls -la ~/.config/opencode/
```

预期：`opencode` 命令可用，且配置目录存在。若目录不存在，让用户先启动一次 OpenCode 后执行：

```bash
~/.local/bin/loongsuite-pilot restart
```

---

## 第 2 步：plugin injection 是否写入配置

OpenCode 支持多个配置文件，pilot 会按下列路径尝试注入：

```bash
for f in ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.json ~/.config/opencode/config.json; do
  [ -f "$f" ] && echo "--- $f" && grep -n "loongsuite-pilot-opencode\|plugins/opencode/plugin.mjs" "$f"
done
```

预期：至少一个配置文件中包含：

```text
file://.../.loongsuite-pilot/plugins/opencode/plugin.mjs
```

以及插件 ID `loongsuite-pilot-opencode`。若缺失 → `~/.local/bin/loongsuite-pilot restart` 重新注入。

> 旧测试插件 `loongsuite-pilot-opencode-smoke` 会被替换；若用户手工改过配置，重启后以 pilot 注入结果为准。

---

## 第 3 步：原始 JSONL 是否生成

```bash
ls -la ~/.loongsuite-pilot/logs/opencode/
tail -20 ~/.loongsuite-pilot/logs/opencode/opencode-$(date +%Y-%m-%d).jsonl \
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

预期：每行包含 `event.name`、`gen_ai.session.id`、`gen_ai.agent.type: "opencode"`，常见事件来自：

- `chat.message`：用户消息与 turn 开始
- `chat.params`：模型 / provider 元数据
- `message.part.updated`：step、工具调用片段
- `message.updated`：LLM 响应聚合与 token usage
- `tool.execute.before` / `tool.execute.after`：工具调用参数与结果
- `session.idle` / `session.error`：会话生命周期清理

文件不存在 / 为空：

- OpenCode 在 plugin 注入后尚未启动或没有完成一次会话
- 配置文件未被 OpenCode 实际读取（路径或格式不匹配）
- plugin.mjs 运行时报错 → 见第 5 步

---

## 第 4 步：pilot 是否成功消费

```bash
# 4.1 游标是否前进
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json 2>/dev/null \
  | grep -A 3 '"opencode-log"'

# 4.2 输出是否产出
ls -la ~/.loongsuite-pilot/logs/output/ | grep opencode
tail -20 ~/.loongsuite-pilot/logs/output/opencode-$(date +%Y-%m-%d).jsonl 2>/dev/null \
  | python3 -c '
import json, sys
for line in sys.stdin:
    if not line.strip():
        continue
    r = json.loads(line)
    print({"event.name": r.get("event.name"), "agent": r.get("gen_ai.agent.type"), "session": r.get("gen_ai.session.id")})
'
```

预期：`opencode-log` 有 `lastOffset`，output 中存在 `gen_ai.agent.type = "opencode"` 的记录。

`lastOffset` 不前进的可能原因：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `opencode-log` Input 被禁用 → 检查 `listeners["opencode-log"]`
- 原始 JSONL 没有新增 → 回第 3 步

---

## 第 5 步：插件错误与配置冲突定位

### 5.1 plugin.mjs 是否存在

```bash
ls -l ~/.loongsuite-pilot/plugins/opencode/plugin.mjs
```

缺失 → 安装/升级过程未正确拷贝 assets，重跑安装或升级。

### 5.2 插件错误日志

```bash
tail -50 ~/.loongsuite-pilot/logs/opencode/opencode-error-$(date +%Y-%m-%d).log
```

常见问题：

- OpenCode 配置支持的 plugin 字段格式发生变化，导致插件没有加载
- OpenCode 事件 API 版本差异，`message.updated` / `tool.execute.*` payload 不符合预期
- `LOONGSUITE_PILOT_DATA_DIR` 指向不同目录，plugin 写到别处而 pilot 读默认目录

### 5.3 数据目录是否一致

```bash
env | grep LOONGSUITE_PILOT_DATA_DIR || true
~/.local/bin/loongsuite-pilot status
```

如果 OpenCode 进程启动时带了 `LOONGSUITE_PILOT_DATA_DIR`，pilot 服务也必须读取同一个数据目录，否则 plugin 写入和 Input 读取会错位。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.config/opencode/opencode.jsonc` | OpenCode 主配置候选之一 |
| `~/.config/opencode/opencode.json` | OpenCode 主配置候选之一 |
| `~/.config/opencode/config.json` | OpenCode 主配置候选之一 |
| `~/.loongsuite-pilot/plugins/opencode/plugin.mjs` | OpenCode 进程内插件 |
| `~/.loongsuite-pilot/logs/opencode/opencode-YYYY-MM-DD.jsonl` | 插件输出原始 JSONL |
| `~/.loongsuite-pilot/logs/opencode/opencode-error-YYYY-MM-DD.log` | 插件错误日志 |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `opencode-log` 增量游标 |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| 配置中没有 plugin.mjs | `loongsuite-pilot restart` 重新注入 OpenCode plugin |
| 配置有 plugin 但没有 JSONL | 重新启动 OpenCode，并完成一次对话；若仍无，查看 `opencode-error-*.log` |
| JSONL 有数据但 output 无 | 检查 `opencode-log` 游标是否前进、pilot 是否运行、listener 是否被禁用 |
| plugin 写到非默认目录 | 检查 OpenCode 启动环境中的 `LOONGSUITE_PILOT_DATA_DIR` 是否与 pilot 服务一致 |
| OpenCode 升级后数据中断 | 先 `loongsuite-pilot restart` 重写配置；若仍失败，查看 OpenCode plugin API 是否变化 |
