# Codex 插件接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/codex-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下的 log 采集与写入链路**，不包含 OTLP trace 远端导出排查。

---

## 系统化排查顺序

Codex 数据未出现时，**按以下顺序逐步排查，勿跳步**——后一步的结论依赖前一步：

```
第 1 步 → codex 版本 + hook trust 状态
第 2 步 → 原始 JSONL 是否生成（hook 是否被触发）
第 3 步 → pilot 是否成功消费（input-state 推进 + output 产出）
第 4 步 → Trust / Feature flag 细节定位
第 5 步 → 配置文件三件套对照检查
```

---

## 第 1 步：codex 版本 + hook trust 状态

```bash
codex --version          # 必须 >= 2026-04-22 stable hooks 版本（约 codex >= 0.103）
```

trust 状态没有顶层 CLI 命令查看，需要进入 codex TUI 后用 slash 命令：

```bash
codex                    # 启动 TUI
# 在输入框输入: /hooks   →  打开 hooks browser，逐 event 查看 trust 状态
```

或者：如果存在任何 `Untrusted` / `Modified` hook，**`codex` 启动时会自动弹出 "Hooks need review" 对话框**——这是最常见的发现入口，无需手工查询。

我们的 5 个 hook（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`）应当全部为 **`Trusted`** 或 **`Managed`**。

| 状态 | 含义 | 处理 |
|------|------|------|
| `Trusted` ✅ | trusted_hash 与当前算出一致 | 正常 |
| `Managed` ✅ | 由 system requirements.toml 声明（pilot 场景一般不用） | 正常 |
| `Untrusted` ❌ | `[hooks.state]` 里没写 trusted_hash | 重跑 `~/.loongsuite-pilot/plugins/otel-codex-hook/bin/otel-codex-hook install` |
| `Modified` ❌ | 写过但 hash 不匹配（环境变化或算法漂移） | 同上重装；若仍 Modified 见第 4 步 |

不便启动 TUI 时，可直接用第 4 步的 grep 命令离线核对 `[hooks.state]` 段。

---

## 第 2 步：检查原始 JSONL（hook 是否被触发）

pilot 默认从 `~/.codex/otel-config.json` 读 `log_dir`，未配置时 fallback 到 `~/.loongsuite-pilot/logs/codex/`：

```bash
ls -la ~/.loongsuite-pilot/logs/codex/
tail -2 ~/.loongsuite-pilot/logs/codex/codex-$(date +%Y-%m-%d).jsonl | python3 -m json.tool
```

预期：
- 文件名严格为 `codex-YYYY-MM-DD.jsonl`
- 每行 JSON 包含 `event.name` ∈ `{llm.request, llm.response, tool.call, tool.result}`
- `agent.type = "codex"`、`session.id`、`turn.id` 必须有值

文件不存在 / 为空：hook 未被触发，开 debug 模式定位：

```bash
CODEX_TELEMETRY_DEBUG=1 codex "say hi" 2>/tmp/codex-debug.log
cat /tmp/codex-debug.log
```

正常应看到：
```
[otel-codex-hook] Parsed transcript: N LLM call(s), X in / Y out
[otel-codex-hook] Wrote N log records
```

若 stderr 完全没有 `[otel-codex-hook]` 输出 → 跳第 4/5 步排查 trust + 配置。

---

## 第 3 步：pilot 是否成功消费

```bash
# 3.1 增量进度是否前进
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool | grep -A 2 '"codex-log"'

# 3.2 pilot 输出是否产出（平铺文件，文件名前缀含 agentType）
ls -la ~/.loongsuite-pilot/logs/output/ | grep '^.*codex-'
tail -2 ~/.loongsuite-pilot/logs/output/codex-$(date +%Y-%m-%d).jsonl
```

预期：
- `input-state.json` 中存在 `codex-log` 条目，`lastOffset` 数值持续增大
- output 目录产出 JSONL，与第 2 步原始日志记录数大致对齐

`lastOffset` 不前进的可能原因：
- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `codex-log` Input 未注册 → `tail ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`，搜 `codex-log`
- `log_dir` 路径在 pilot 与插件之间不一致 → 见第 5 步

---

## 第 4 步：Trust / Feature flag 细节定位

仅当第 1 步 `/hooks` 不全 `Trusted` 时进入此步。

#### 4.1 检查 `[hooks.state]` 是否写入

```bash
grep -A 1 '\[hooks\.state\."[^"]*hooks\.json:[a-z_]*:0:0"\]' ~/.codex/config.toml
```

预期：5 个 event（`session_start` / `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `stop`）的段头各出现一次，每段后接 `trusted_hash = "sha256:..."`。

#### 4.2 检查是否有"裸"残留段（duplicate key bug 的先兆）

```bash
# 计算 [hooks.state."xxx:0:0"] 段头出现次数
grep -c '\[hooks\.state\."[^"]*hooks\.json:[a-z_]*:0:0"\]' ~/.codex/config.toml
```

预期数值为 5。若 > 5 → 老版插件残留 + 新版重写造成 duplicate，重跑 `otel-codex-hook install`（>= 2026-05-13 版本会自动清理）。

#### 4.3 检查 `[features] hooks` 是否被禁用

```bash
grep -E '^hooks\s*=' ~/.codex/config.toml || echo "(未显式设置，使用默认 true)"
```

若结果是 `hooks = false`，说明用户主动禁用过；重跑 install 会改回 true 并 stderr 警告（详见 install 输出）。

#### 4.4 验证 TOML 可解析（duplicate key 自检）

```bash
node -e "
try {
  const t = require('@ltd/j-toml');  // 需先 npm i -g @ltd/j-toml 或换其他 parser
  t.parse(require('fs').readFileSync(process.argv[1], 'utf-8'), {joiner:'\n'});
  console.log('TOML_OK');
} catch(e) { console.log('TOML_FAIL:', e.message); }
" ~/.codex/config.toml
```

或直接 `codex` 启动看是否报 `failed to load configuration: ... duplicate key`。

---

## 第 5 步：配置文件三件套对照检查

#### `~/.codex/hooks.json`

```bash
python3 -m json.tool ~/.codex/hooks.json
```

预期：`hooks` 下含 5 个 event，每个 event 数组里至少有一项的 `command` 形如 `bash /Users/.../hook-entry.sh <subcommand>`。

#### `~/.codex/otel-config.json`

```bash
python3 -m json.tool ~/.codex/otel-config.json
```

预期字段：

```jsonc
{
  "log_enabled": true,
  "log_dir": "/Users/<you>/.loongsuite-pilot/logs/codex",
  "log_filename_format": "hook"
}
```

#### `hook-entry.sh` 实际可执行

```bash
cat ~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh
ls -l ~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh   # 应有 x 权限
```

若 hook-entry.sh 引用的 `bin/otel-codex-hook` 路径在 pilot 重装后失效 → 重跑 `otel-codex-hook install` 会重新生成。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.codex/hooks.json` | 5 个 hook 的注册（pilot 安装时由 install 命令写入） |
| `~/.codex/config.toml` | `[hooks.state]` trust hash + `[features] hooks` flag |
| `~/.codex/otel-config.json` | 共享配置，`log_enabled` / `log_dir` / `log_filename_format` |
| `~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh` | Node.js wrapper，含路径自动探测 |
| `~/.cache/opentelemetry.instrumentation.codex/sessions/` | 运行时 session state（成功导出后清理；残留=Stop hook 失败） |
| `~/.loongsuite-pilot/plugins/otel-codex-hook/` | pilot 解压目录 |
| `~/.loongsuite-pilot/logs/codex/codex-YYYY-MM-DD.jsonl` | 插件输出原始 JSONL（默认目录） |
| `~/.loongsuite-pilot/logs/output/codex-YYYY-MM-DD.jsonl` | pilot 处理后的 JSONL（平铺,文件名前缀 = agentType） |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `codex-log` 增量游标 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| `failed to load configuration: ... duplicate key` | 老版插件残留导致 `[hooks.state."...:0:0"]` 段重复出现。重跑 `otel-codex-hook install` ≥ 2026-05-13 版本（会自动清理） |
| TUI `/hooks` 显示全部 Untrusted | trust block 缺失。重跑 `otel-codex-hook install` |
| TUI `/hooks` 显示 Modified | hash 不匹配，常因 hook-entry.sh 路径变了或 codex 升级导致算法漂移。重跑 install 重新计算 |
| 启动时弹 "Hooks need review" 对话框 | 任意 hook 处于 Untrusted/Modified；处理 trust 后再启动，或临时选 "Trust all and continue" |
| `[features] hooks = false` 警告 | 用户主动禁用过；install 会自动改 true 并提醒（注意这是全局开关） |
| `hook: Stop Failed` 异常 | 多见于 `OTEL_EXPORTER_OTLP_ENDPOINT=""` 空值导致。**不要**设置空 endpoint 环境变量，未启用 OTLP 直接不设置即可 |
| 重装 pilot 后 hook 不生效 | pilot 安装脚本必须始终调用 `otel-codex-hook install` 注册（不能因解压跳过而 early return）。检查 pilot 版本 |
| `~/.loongsuite-pilot/logs/codex/` 不生成日志 | 1) `~/.codex/otel-config.json` 的 `log_enabled` 不为 true；2) hook 未触发（看第 1/2 步）；3) `log_dir` 指向了别的路径（`grep log_dir ~/.codex/otel-config.json`） |
| pilot output 目录无产出但原始 JSONL 有 | pilot 服务未运行 / `codex-log` Input 未注册 / `log_dir` 与 pilot resolveCodexLogDir 不一致 |
| 桌面版 codex 装完后仍提示需手动启用 | 桌面版可能有独立 codex_home 路径或自有 hooks 设置面板；先用 TUI `/hooks` 或第 4 步 grep 离线核对 `[hooks.state]`；详见 codex-plugin-context.md 9.4.5 |
| `CLAUDE_TELEMETRY_DEBUG` 不生效 | codex 插件用 `CODEX_TELEMETRY_DEBUG`，环境变量名不要混用 |
| `~/.cache/.../sessions/` 长期残留 session 文件 | Stop hook 异常未触发 clearState；通常伴随 `Export failed` 错误日志，重跑或清空 sessions 目录 |
| 监控面板 `Last activity` 显示时间早于 JSONL 末尾时间（数据已采集但 dashboard 卡住） | dashboard 是按需懒索引，单次刷新最多吃 5 MiB / 2 万行。Codex 单行通常 5–30 KB，多轮长会话 jsonl 仍可能超阈值。先 `grep '\[overview\] partial index' ~/.loongsuite-pilot/logs/loongsuite-pilot-dashboard.log` 确认；命中后多刷几次 dashboard（间隔 ≥5 秒）即可。详见 `monitoring.md` 的 "Dashboard Last activity 显示落后于真实时间" 章节 |
