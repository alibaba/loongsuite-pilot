# Cursor 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/cursor-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下的 Cursor hook 采集与写入链路**，不包含 OTLP trace 远端导出排查。

---

## 采集链路概览

```
Cursor IDE / CLI 触发 hook 事件
    ↓ stdin JSON payload
~/.loongsuite-pilot/hooks/cursor-loongsuite-pilot-hook.sh
    ↓ 解析 Node，委派
~/.loongsuite-pilot/hooks/cursor-hook-processor.mjs
    ↓ append-only JSONL
~/.loongsuite-pilot/logs/cursor/history/cursor-YYYY-MM-DD.jsonl
    ↓ byte-offset tail
pilot 服务 `cursor-hook` Input → normalization → flushers → logs/output/
```

关键事实：
- Hook 注入位置：`~/.cursor/hooks.json`，flat 格式，12 个事件
- Hook 只写本地 JSONL，**不**直接发送到 SLS/HTTP，一定要 pilot 服务存活才能完成消费
- 失败 fail-open：hook/processor 异常都输出 `{}` 并 exit 0，**不会阻塞 Cursor**

---

## 系统化排查顺序

Cursor 数据未出现时，**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → Cursor 版本（低版本不支持 hooks.json，是最常见的根因）
第 2 步 → hook 注册状态（~/.cursor/hooks.json 是否含 12 个事件）
第 3 步 → 原始 JSONL 是否生成（hook 是否被触发）
第 4 步 → pilot 是否成功消费（input-state 推进 + output 产出）
第 5 步 → 配置文件三件套对照检查（hooks.json + shell + processor + node）
```

---

## 第 1 步：Cursor 版本检查（特殊必查）

`~/.cursor/hooks.json` 是 Cursor 较新版本引入的能力，**旧版本 Cursor 启动时会忽略这个文件，hook 永远不会被触发**，表现为：
- `~/.loongsuite-pilot/logs/cursor/history/` 目录不存在或长期为空
- `~/.cursor/hooks.json` 虽然已写入 12 个事件，但 Cursor 从未调用

排查方法：

```bash
# 方法 1：从 Cursor 主菜单查看 About/关于
# 方法 2：从历史日志里读取 cursor_version（需要至少成功触发过一次）
grep -o '"cursor_version":"[^"]*"' \
  ~/.loongsuite-pilot/logs/cursor/history/cursor-*.jsonl 2>/dev/null | sort -u
```

处理方法：
- **升级 Cursor 到最新稳定版**（项目内验证过的版本如 `3.2.16`）
- 升级后重启 Cursor，并再发起一次对话触发 hook
- 如果用户明确表示无法升级 → 直接告知当前 pilot 无法在该版本 Cursor 上采集数据，结束排查

> ⚠️ 除此之外 Cursor 侧**没有** trust/feature flag 之类的开关，不必按 Claude Code / Codex 的思路去找 "trust" / "hooks feature"。

---

## 第 2 步：hook 注册状态

Cursor 通过 `~/.cursor/hooks.json` 配置 hook（无 trust 机制，写入即生效）。
pilot 启动时只要检测到 `~/.cursor/` 目录存在，就会自动写入 12 个事件。

```bash
# 2.1 文件必须存在且为合法 JSON
python3 -m json.tool ~/.cursor/hooks.json >/dev/null && echo OK

# 2.2 注册了 12 个事件，每个事件都有一条指向 cursor-loongsuite-pilot-hook.sh 的 command
python3 -m json.tool ~/.cursor/hooks.json | grep -c "cursor-loongsuite-pilot-hook.sh"
```

预期输出：**12**。对应的 12 个事件：

| 事件分组 | 事件名 |
|---------|-------|
| 会话 | `sessionStart`, `sessionEnd`, `stop` |
| 提示 | `beforeSubmitPrompt`, `preCompact` |
| 工具 | `preToolUse`, `postToolUse`, `postToolUseFailure` |
| 子代理 | `subagentStart`, `subagentStop` |
| 回应 | `afterAgentResponse`, `afterAgentThought` |

每条 entry 应为 flat 格式：

```jsonc
{ "type": "command", "command": "/Users/<you>/.loongsuite-pilot/hooks/cursor-loongsuite-pilot-hook.sh", "matcher": "*" }
```

如果计数不为 12，或 `hooks.json` 不存在 / `version` 字段缺失：

```bash
# 重启 pilot 即可触发重新注入（幂等，不会重复写入）
~/.local/bin/loongsuite-pilot restart
```

---

## 第 3 步：检查原始 JSONL（hook 是否被触发）

hook 被触发后，`cursor-hook-processor.mjs` 会把 payload 补全 `event.id` / `agent.type` / `time_unix_nano` 等字段后追加写入：

```bash
ls -la ~/.loongsuite-pilot/logs/cursor/history/
tail -2 ~/.loongsuite-pilot/logs/cursor/history/cursor-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

预期：文件存在且每行能被 `python3 -m json.tool` 正常解析（有 JSON 内容即可，具体字段名后续仍会调整，此处不固化）。

文件不存在 / 为空：说明 hook 完全没被触发，优先级从高到低：
1. **Cursor 版本过低** → 回第 1 步
2. `~/.cursor/hooks.json` 被用户改坏 / 被其他工具覆盖 → 回第 2 步重新注入
3. `cursor-loongsuite-pilot-hook.sh` 或 `cursor-hook-processor.mjs` 文件丢失 → 见第 5 步
4. Node runtime 不可用 → 见第 5 步 "Node pin"

`processor` 自己出错时不会污染 history，而是写到 errors 目录：

```bash
ls -la ~/.loongsuite-pilot/logs/cursor/errors/
tail -5 ~/.loongsuite-pilot/logs/cursor/errors/cursor-error-$(date -u +%Y-%m-%d).jsonl
```

常见 `stage` 值：
- `missing_processor` — shell 找不到 `.mjs`
- `missing_node` — 找不到可用 node (>= 18)
- `parse` / `invalid_payload_root` — stdin 不是合法 JSON 对象
- `append_failed` — history 目录无写权限
- `processor_failed` — processor 进程非零退出

---

## 第 4 步：pilot 是否成功消费

```bash
# 4.1 增量进度是否前进（id = cursor-hook）
cat ~/.loongsuite-pilot/logs/input-state.json | python3 -m json.tool \
  | grep -A 3 '"cursor-hook"'

# 4.2 pilot 输出是否产出（output 目录按 agentType 前缀平铺）
ls -la ~/.loongsuite-pilot/logs/output/ | grep cursor
tail -2 ~/.loongsuite-pilot/logs/output/cursor-$(date -u +%Y-%m-%d).jsonl
```

预期：
- `input-state.json` 中存在 `cursor-hook` 条目，`lastFile` = 当天 history 文件名，`lastOffset` 数值持续增大
- output 目录产出 JSONL，与第 3 步原始日志记录数大致对齐（少量 `event.name = other` 的事件会被 transform 丢弃，属于正常现象）

`lastOffset` 不前进的可能原因：
- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `cursor-hook` Input 未注册 → `tail ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`，搜 `cursor-hook`
- history 目录路径被覆盖（默认 `~/.loongsuite-pilot/logs/cursor/history/`）→ 见第 5 步

---

## 第 5 步：配置文件三件套对照检查

#### 5.1 `~/.cursor/hooks.json`

```bash
python3 -m json.tool ~/.cursor/hooks.json
```

预期顶层结构：

```jsonc
{
  "version": 1,
  "hooks": {
    "stop": [ { "type": "command", "command": ".../cursor-loongsuite-pilot-hook.sh", "matcher": "*" } ],
    "preToolUse": [ ... ],
    // ... 其余 10 个事件
  }
}
```

若 `version` 字段缺失，pilot 启动时会自动补 `version: 1`；手工编辑不要删掉这个字段。

#### 5.2 `cursor-loongsuite-pilot-hook.sh` 可执行

```bash
ls -l ~/.loongsuite-pilot/hooks/cursor-loongsuite-pilot-hook.sh   # 需要 x 权限
ls -l ~/.loongsuite-pilot/hooks/cursor-hook-processor.mjs         # processor 必须在 shell 同级目录
```

两个文件由 `scripts/postinstall.js` 部署，pilot 包升级时会重新覆盖。两者不可缺一：
- 缺 `*.sh` → Cursor 找不到命令，hook 静默失败
- 缺 `*.mjs` → shell 命中 `missing_processor` 分支，写 error JSONL 后 exit 0

#### 5.3 Node runtime

```bash
# pilot 首次启动时会固定一条 node 路径到这里（>= 18 的非 .app-bundle node）
cat ~/.loongsuite-pilot/node-bin
"$(cat ~/.loongsuite-pilot/node-bin)" --version
```

若 `node-bin` 指向的路径失效（如用户卸载了 nvm），shell 会按以下顺序 fallback 搜索（只读不更新 pin）：

```
~/.nvm/versions/node/*/bin/node  (新版本优先)
~/.volta/bin/node
~/.fnm/aliases/default/bin/node
/opt/homebrew/bin/node
/usr/local/bin/node
~/.local/bin/node
$(command -v node)
```

全部不可用 → `~/.loongsuite-pilot/logs/cursor/errors/` 会出现 `stage: missing_node`。处理方法：

```bash
# 重新安装一个 >= 18 的系统级 node，然后重启 pilot 让它重新 pin
~/.local/bin/loongsuite-pilot restart
```

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.cursor/hooks.json` | 12 个 hook 事件的注册，pilot 启动时由 `Orchestrator.installHooks()` 写入 |
| `~/.loongsuite-pilot/hooks/cursor-loongsuite-pilot-hook.sh` | Cursor 调用入口，负责 Node 解析 + fail-open |
| `~/.loongsuite-pilot/hooks/cursor-hook-processor.mjs` | 解析 stdin JSON，补全 `event.id` / `time_unix_nano`，append 到 history |
| `~/.loongsuite-pilot/node-bin` | 固定的 node 可执行路径（首启写入，读-only fallback 时不更新） |
| `~/.loongsuite-pilot/logs/cursor/history/cursor-YYYY-MM-DD.jsonl` | processor 输出的原始 hook 记录（pilot Input 消费源） |
| `~/.loongsuite-pilot/logs/cursor/errors/cursor-error-YYYY-MM-DD.jsonl` | processor 失败时写的错误流水（best-effort） |
| `~/.loongsuite-pilot/logs/output/cursor-YYYY-MM-DD.jsonl` | pilot 规范化后的输出（按 agentType 前缀平铺） |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `cursor-hook` 增量游标（`lastFile` + `lastOffset`） |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| `~/.loongsuite-pilot/logs/cursor/history/` 始终为空 | **首查 Cursor 版本**。老版本不识别 `hooks.json`，升级 Cursor 到最新稳定版 |
| `~/.cursor/hooks.json` 中没有 `cursor-loongsuite-pilot-hook.sh` | pilot 安装时 `~/.cursor/` 目录不存在，导致跳过注入。先确保 Cursor 启动过一次生成 `~/.cursor/`，再 `loongsuite-pilot restart` |
| `hooks.json` 里 command 数量少于 12 | pilot 升级后新增了事件。`loongsuite-pilot restart` 触发幂等补注入 |
| history 里有 JSONL 但 `input-state.json` 没有 `cursor-hook` 游标 | pilot 服务未运行或 Input 未注册。`loongsuite-pilot status` + 查 service.log |
| errors 目录出现 `stage: missing_node` | Node >= 18 不可用。装一个系统级 node，然后 `loongsuite-pilot restart` 重新 pin |
| errors 目录出现 `stage: missing_processor` | `cursor-hook-processor.mjs` 丢失。通常由用户手工删除 `~/.loongsuite-pilot/hooks/`，重装 pilot 即可恢复 |
| errors 目录出现 `stage: append_failed` | `~/.loongsuite-pilot/logs/cursor/history/` 无写权限。`ls -ld` 检查目录权限 / 磁盘空间 |
| history 里 `cursor_version` 字段缺失 | 非常旧的 Cursor 不注入该字段；与其排查数据，不如先升级 Cursor |
| Claude Code 插件同时存在时 Cursor 数据"混入" claude-code 日志 | Claude Code 插件检测到 `cursor_version` 会自动跳过；相反方向不会出现混入，可无视 |
| 重装 pilot 后 hook 不生效 | 确认 pilot 启动日志里看到 `cursor hook registered`；若没有，检查 `~/.cursor/` 是否存在（不存在时 Orchestrator 会整体跳过注入） |
| 只有 `postToolUse` / `afterAgentResponse`，没有 `sessionStart` | Cursor 版本虽然识别 hooks.json，但不支持全部 12 事件。功能正常，子集事件不影响 Token/Chat 采集的主路径 |
