# Claude Code 插件接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/claude-code-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下的 log 采集与写入链路**，不包含 OTLP trace 远端导出排查。

---

## 系统化排查顺序

Claude Code 数据未出现时，**按以下顺序逐步排查，勿跳步**——后一步的结论依赖前一步：

```
第 1 步 → hook 注册状态（settings.json 是否写入）
第 2 步 → 原始 JSONL 是否生成（hook 是否被触发）
第 3 步 → pilot 是否成功消费（input-state 推进 + output 产出）
第 4 步 → Cursor 冲突 + transcript 路径排查
第 5 步 → 配置文件三件套对照检查
```

---

## 第 1 步：hook 注册状态

Claude Code 通过 `~/.claude/settings.json` 配置 hook（无 trust 机制，写入即生效）。

```bash
# 检查 settings.json 中是否注册了 8 个 hook 事件
python3 -m json.tool ~/.claude/settings.json 2>/dev/null | grep -c "otel-claude-hook\|hook-entry.sh"
```

预期输出：**8**（每个 hook 事件各一条）。

对应的 8 个事件：

| Hook 事件 | 子命令 |
|-----------|--------|
| `UserPromptSubmit` | `user-prompt-submit` |
| `PreToolUse` | `pre-tool-use` |
| `PostToolUse` | `post-tool-use` |
| `Stop` | `stop` |
| `PreCompact` | `pre-compact` |
| `SubagentStart` | `subagent-start` |
| `SubagentStop` | `subagent-stop` |
| `Notification` | `notification` |

如果计数不为 8，或 settings.json 不存在：

```bash
# 重新安装 hook
~/.loongsuite-pilot/plugins/otel-claude-hook/package/bin/otel-claude-hook install --user --no-alias
```

> ⚠️ Claude Code 同时读取用户级 `~/.claude/settings.json` 和项目级 `.claude/settings.json`。pilot 安装写入的是用户级。如果项目级 settings 中有同名 hook 配置，可能覆盖用户级。

---

## 第 2 步：检查原始 JSONL（hook 是否被触发）

pilot 默认从 `~/.claude/otel-config.json` 读 `log_dir`，未配置时 fallback 到 `~/.loongcollector/data/`：

```bash
ls -la ~/.loongsuite-pilot/logs/claude-code/
tail -2 ~/.loongsuite-pilot/logs/claude-code/claude-code-$(date +%Y-%m-%d).jsonl | python3 -m json.tool
```

预期：
- 文件名严格为 `claude-code-YYYY-MM-DD.jsonl`（需 `log_filename_format: "hook"`）
- 每行 JSON 包含 `event.name` ∈ `{llm.request, llm.response, tool.call, tool.result}`
- `session.id`、`turn.id` 必须有值

文件不存在 / 为空：hook 未被触发，开 debug 模式定位：

```bash
CLAUDE_TELEMETRY_DEBUG=1 claude "say hi" 2>/tmp/claude-debug.log
cat /tmp/claude-debug.log
```

正常应看到：
```
[otel-claude-hook] Parsed transcript: N LLM call(s), X in / Y out
✅ Session logged | 1 turn(s) | X in, Y out | Z.Zs
```

若 stderr 完全没有 `[otel-claude-hook]` 或 `✅` 输出 → 跳第 4/5 步排查配置。

### 2.1 hook-entry.sh 是否可执行

```bash
cat ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh
ls -l ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh   # 应有 x 权限
```

hook-entry.sh 内部解析路径的三级策略：
1. 相对路径 `$(dirname "$0")/package/bin/otel-claude-hook`（基于自身位置）
2. 安装时写入的绝对路径（fallback）
3. 都找不到时 `exit 0`（不阻塞 Claude Code，但 hook 静默失败）

若引用的 `bin/otel-claude-hook` 路径失效 → 重跑 `otel-claude-hook install --user --no-alias` 会重新生成。

---

## 第 3 步：pilot 是否成功消费

```bash
# 3.1 增量进度是否前进
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool | grep -A 2 '"claude-code-log"'

# 3.2 pilot 输出是否产出
ls -la ~/.loongsuite-pilot/logs/output/claude-code/
tail -2 ~/.loongsuite-pilot/logs/output/claude-code/*.jsonl
```

预期：
- `input-state.json` 中存在 `claude-code-log` 条目，`lastOffset` 数值持续增大
- output 目录产出 JSONL，与第 2 步原始日志记录数大致对齐

`lastOffset` 不前进的可能原因：
- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `claude-code-log` Input 未注册 → `tail ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`，搜 `claude-code-log`
- `log_dir` 路径在 pilot 与插件之间不一致 → 见第 5 步

---

## 第 4 步：Cursor 冲突 + transcript 路径排查

### 4.1 Cursor IDE 冲突

Cursor IDE 也使用 Claude Code 的 hook 机制。当 hook 事件的 stdin JSON 中包含 `cursor_version` 字段时，插件会**自动跳过处理**。

如果用户同时使用 Cursor 和 Claude Code CLI：
- Cursor 触发的 hook 被正确跳过 ✅
- Claude Code CLI 触发的 hook 正常处理 ✅

排查 Cursor 误触发的方法：

```bash
# 在 debug 模式下观察 stderr，Cursor 调用会被静默跳过（无输出）
CLAUDE_TELEMETRY_DEBUG=1 claude "test"
# 预期看到正常的 hook 处理日志
```

如果怀疑 hook 配置被 Cursor 覆盖：

```bash
# 检查 settings.json 中的 hook command 是否仍指向 otel-claude-hook
python3 -m json.tool ~/.claude/settings.json | grep "command"
```

每个 command 应为 `bash /Users/.../.cache/opentelemetry.instrumentation.claude/hook-entry.sh <subcommand>` 格式。若被替换为其他命令 → 重跑 install。

### 4.2 transcript 路径

Claude Code 将对话记录写入 `~/.claude/projects/<hash>/<session-id>.jsonl`。插件在 `UserPromptSubmit` hook 中接收 `transcript_path` 并保存到 session state，在 `Stop` hook 中解析该文件提取 LLM 数据。

```bash
# 检查最近的 session state 文件，确认 transcript_path 是否存在
ls -lt ~/.cache/opentelemetry.instrumentation.claude/sessions/ | head -5
# 选一个最新的查看
cat ~/.cache/opentelemetry.instrumentation.claude/sessions/<session-id>.json | python3 -m json.tool | grep transcript_path
```

如果 `transcript_path` 为空：
- Claude Code 版本过老，不在 `UserPromptSubmit` stdin 中提供该字段
- 插件会回退到 intercept.js 方式（需要 shell alias），日志中 LLM 数据可能缺失

如果 transcript 文件存在但日志中无 LLM 数据：
```bash
# 检查 transcript 文件是否可读且非空
wc -l "$(cat ~/.cache/opentelemetry.instrumentation.claude/sessions/<session-id>.json | python3 -c 'import json,sys;print(json.load(sys.stdin).get("transcript_path",""))')"
```

---

## 第 5 步：配置文件三件套对照检查

#### `~/.claude/settings.json`

```bash
python3 -m json.tool ~/.claude/settings.json
```

预期：`hooks` 下含 8 个 event key，每个 event 数组里有一项的 `command` 形如 `bash /Users/.../.cache/opentelemetry.instrumentation.claude/hook-entry.sh <subcommand>`，每个都带 `matcher: "*"`。

#### `~/.claude/otel-config.json`

```bash
python3 -m json.tool ~/.claude/otel-config.json
```

预期字段：

```jsonc
{
  "log_enabled": true,
  "log_dir": "/Users/<you>/.loongsuite-pilot/logs/claude-code",
  "log_filename_format": "hook"
}
```

| 字段 | 必须 | 说明 |
|------|------|------|
| `log_enabled` | ✅ | 必须为 `true` 才会写 JSONL |
| `log_dir` | ✅ | 必须与 pilot 的 `claude-code-log` input 读取路径一致 |
| `log_filename_format` | ✅ | 必须为 `"hook"`，产出 `claude-code-YYYY-MM-DD.jsonl` |
| `otlp_endpoint` | 可选 | pilot log-only 场景不需要 |
| `debug` | 可选 | 设为 `true` 等效 `CLAUDE_TELEMETRY_DEBUG=1` |

#### `hook-entry.sh` 实际可执行

```bash
cat ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh
ls -l ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh   # 应有 x 权限
```

验证 hook-entry.sh 中引用的 bin 路径是否存在：

```bash
# 提取 BIN_PATH 行，查看实际解析路径
grep 'BIN_PATH=' ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh

# 检查相对路径（hook-entry.sh 同级 package/ 目录）
ls -l ~/.cache/opentelemetry.instrumentation.claude/package/bin/otel-claude-hook

# pilot 安装场景的解压目录（两者可能不同）
ls -l ~/.loongsuite-pilot/plugins/otel-claude-hook/package/bin/otel-claude-hook
```

> hook-entry.sh 优先使用相对路径（`$SCRIPT_DIR/package/bin/`），找不到时退回安装时写入的绝对路径。两个路径都不存在时 hook 静默 exit 0。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.claude/settings.json` | 8 个 hook 的注册（pilot 安装时由 install 命令写入） |
| `~/.claude/otel-config.json` | 共享配置，`log_enabled` / `log_dir` / `log_filename_format` |
| `~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh` | Node.js wrapper，含路径自动探测（三级策略） |
| `~/.cache/opentelemetry.instrumentation.claude/sessions/` | 运行时 session state（成功导出后清理事件；残留 = Stop hook 异常） |
| `~/.claude/projects/<hash>/<session>.jsonl` | Claude Code 原生 transcript（插件解析 LLM 数据的来源） |
| `~/.loongsuite-pilot/plugins/otel-claude-hook/` | pilot 解压目录 |
| `~/.loongsuite-pilot/logs/claude-code/claude-code-YYYY-MM-DD.jsonl` | 插件输出原始 JSONL（默认目录） |
| `~/.loongsuite-pilot/logs/output/claude-code/` | pilot 处理后的 JSONL |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `claude-code-log` 增量游标 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| `settings.json` 中无 hook 配置 | 重跑 `otel-claude-hook install --user --no-alias`。pilot 重装后必须执行此步 |
| hook-entry.sh 中路径不存在（`bin not found`） | pilot 重装后路径变化。重跑 `otel-claude-hook install --user --no-alias` 重新生成 |
| `otel-config.json` 的 `log_enabled` 不为 `true` | 修改为 `true` 或重跑 pilot 安装（安装脚本会自动写入） |
| 日志文件名不是 `claude-code-YYYY-MM-DD.jsonl` | 检查 `log_filename_format` 是否为 `"hook"`；非 `"hook"` 时文件名为 `claude-code.jsonl.YYYYMMDD`，pilot 无法识别 |
| `log_dir` 路径与 pilot 不一致 | pilot 默认读 `~/.loongsuite-pilot/logs/claude-code/`，`otel-config.json` 中的 `log_dir` 必须指向同一目录 |
| 日志中只有 `tool.call` / `tool.result`，无 `llm.request` / `llm.response` | transcript 路径缺失或不可读。检查第 4.2 步 |
| `llm.response` 中 token 数全为 0 | transcript 中 assistant record 缺少 `usage` 字段，通常是 Claude Code 版本过老 |
| Stop hook 后 session state 文件残留不清理 | `exportSessionTrace` 异常。开 debug 查看 stderr 错误：`CLAUDE_TELEMETRY_DEBUG=1 claude "test"` |
| 多轮对话只看到第一轮的 LLM 数据 | 插件版本过旧，未支持增量 transcript 读取（Issue 6 修复）。升级插件到 >= 0.2.0-beta |
| 最后一个 `tool.call` 排在最后一个 `llm.response` 之后 | PostToolUse hook 丢失（~30% 概率）导致排序错误。升级插件到 >= 0.2.0-beta（Issue 7 修复） |
| Cursor 使用时 Claude Code 的 hook 数据混乱 | 插件自动检测 `cursor_version` 并跳过 Cursor 调用，正常不会混乱。若 Cursor 覆盖了 settings.json 的 hook 配置 → 重跑 install |
| `CLAUDE_TELEMETRY_DEBUG` 不生效 | 确认环境变量名正确（不是 `CODEX_TELEMETRY_DEBUG`），且在启动 claude 前设置 |
| `npm install` 失败导致插件不可用 | 检查 `/tmp/otel-plugin-npm-err.log`。常见原因：网络不通、Node.js 版本 < 18、npm registry 不可达 |
| `[otel-claude-hook] telemetry export failed` | Stop hook 导出异常但不影响 Claude Code。查看完整错误信息定位：OTLP endpoint 不可达 / log_dir 无写权限 / transcript 文件损坏 |
| 重装 pilot 后 hook 不生效 | 确认 pilot 安装脚本调用了 `otel-claude-hook install`（不能因解压跳过而 early return）。当前版本已修复为每次都全新安装 |
| 监控面板 `Last activity` 显示时间早于 JSONL 末尾时间（数据已采集但 dashboard 卡住） | dashboard 是按需懒索引，单次刷新最多吃 5 MiB / 2 万行。Claude Code 单行可达 100 KB，22 MiB 文件至少要刷 5 次才能追到尾。先 `grep '\[overview\] partial index' ~/.loongsuite-pilot/logs/loongsuite-pilot-dashboard.log` 确认；命中后多刷几次 dashboard（间隔 ≥5 秒）即可。详见 `monitoring.md` 的 "Dashboard Last activity 显示落后于真实时间" 章节 |
