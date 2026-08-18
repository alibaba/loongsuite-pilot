# TRAE CN Trace Demo

TRAE CN 单轮 session 完整调用链的**本地最小验证**。不接入 ARMS / SLS，纯本地跑一个前端看 Trace。

方案设计见 [../../docs/zh-CN/trae-session-trace-path.md](../../docs/zh-CN/trae-session-trace-path.md)。

> **路径约定**：本文用 `$WORKSPACE` 表示本仓库根目录，`$DEMO` 表示 `$WORKSPACE/demo/trae-trace-demo`。
> 代码内不含任何硬编码绝对路径，全部由 `os.homedir()` / `import.meta.url` 推导，可用环境变量覆盖。

## 零依赖，直接跑

```bash
cd $WORKSPACE/demo/trae-trace-demo

# 1. 自检数据源是否就绪
node src/cli.mjs --doctor

# 2. 命令行看 Trace（最快）
node src/cli.mjs

# 3. 起前端
node src/server.mjs
# 打开 http://127.0.0.1:8799/
```

要求 Node >= 18，无需 `npm install`。

## 已验证的实际效果

轨迹按 **ReAct 迭代**组织：一次迭代 = 一个 `STEP`，内含 1 个 `LLM`（本次推理）+ 它下发的 N 个 `TOOL`。
迭代边界取自日志的 `[commit_toolcall_result]`（提交工具结果 = 本次迭代结束、服务端开始生成下一步）。

实测 trace `713499b1…`（7 迭代 / 11 工具 / 42.2s）：

```
── Turn 1  713499b1a844a5b60a6eedae21a32aed  42.18s  7 steps  11 tools
ENTRY enter_ai_application_system          42.18s 无prompt
   AGENT invoke_agent trae-cn              42.18s
      STEP  react step                      4.88s round 1 · 2 tools
         LLM   chat aliyuncs//qwen3.7-max    3.92s TTFT 1493ms
         TOOL  execute_tool SearchCodebase    724ms 结果272字节
         TOOL  execute_tool Grep               16ms 结果16字节     ← 同一次推理并发下发
      STEP  react step                      3.11s round 2 · 2 tools
         LLM   chat aliyuncs//qwen3.7-max    2.92s
         TOOL  execute_tool Grep               12ms 结果16字节
         TOOL  execute_tool LS                 89ms 结果35字节
      … round 3/4/5 …
      STEP  react step                      5.72s round 6 · 1 tools
         LLM   chat aliyuncs//qwen3.7-max    4.84s
         TOOL  execute_tool RunCommand        858ms 结果308字节   ← toolhost 真实输出
      STEP  react step                      4.49s round 7 · 1 tools
         LLM   chat aliyuncs//qwen3.7-max    4.46s              ← 最终回答
         TOOL  execute_tool finish             28ms
```

层级跟仓库 `scripts/validate-trace.mjs` 的结构规则一致：STEP 挂 AGENT、LLM/TOOL 挂 STEP、
每个 STEP 恰好 1 个 LLM、LLM 不晚于所有 TOOL、STEP 之间不重叠。
全日志跑一遍（12 轮 / 271 STEP / 271 LLM / 312 TOOL）结构校验 **0 error**。

准备阶段（`context.resolve` / `prompt.render`）没有推理，不能当 STEP（会违反「每个 STEP 恰好 1 个 LLM」），
改作为 AGENT span 上的 span event + 耗时属性（`trae.context.resolve_ms` / `trae.prompt.render_ms`）。

前端可点击任意 span 查看：span 属性、工具参数、**工具结果全文**、本地 timing 瀑布、服务端 `svr_*` 耗时拆解。

## 数据来源（三源融合）

| 源 | 提供 | 是否需配置 |
|----|------|-----------|
| `ai-agent_*_stdout.log` | 轨迹骨架、**ReAct 迭代边界**、timing 瀑布、工具名/状态/耗时、**工具结果**（`toolcall_resp`）| 否，开箱可用 |
| `toolhost.log` + `jobs/job-*/` | RunCommand 的**参数 + 完整输出 + exit_code + 真实起止** | 否，开箱可用 |
| TRAE Hook 事件 | 用户 prompt、**非失败工具的参数**、**助手最终回答**（`last_assistant_message`）| **是，需配 hook** |

`trace_id` 直接复用 TRAE 的 32 位 hex（与 OTel 格式天然一致），`span_id` 由本地合成。

## 补齐内容：配置 TRAE Hook

不配 hook 时，工具结果仍可从日志的 `toolcall_resp` 拿到，但**没有用户 prompt、助手回答与非失败工具的参数**。

```bash
# 推荐：写入全局配置 ~/.trae-cn/hooks.json，所有工作区生效
node src/install-hooks.mjs --global

# 或只对单个工作区生效：<工作区>/.trae/hooks.json
node src/install-hooks.mjs /path/to/your/workspace

# 只想看生成的配置不写入
node src/install-hooks.mjs --print
```

写入是**合并而非覆盖**：保留你已有的 hook 与其他配置项，写前先备份，重复执行不会重复挂载；已有文件不是合法 JSON 时直接报错退出，不改写。

默认装的是 **pilot 正式 hook**（`assets/hooks/trae-cn-loongsuite-pilot-hook.sh`），产出符合仓库 GenAI 语义规范的记录到 `~/.loongsuite-pilot/logs/trae-cn/history/`，埋点时机与字段映射见
[方案文档 §2.9](../../docs/zh-CN/trae-session-trace-path.md#29-hook-埋点实现已落地)。

然后：

1. **重启 TRAE 窗口**（已打开的窗口不会重载 hook 配置）
2. 确认配置被加载（`is_ok=true` 才算成功）：
   ```bash
   grep -aE "resolve_hooks_config result|parse_hooks_config" \
     ~/Library/Application\ Support/Trae\ CN/logs/*/Modular/ai-agent_*_stdout.log | tail -5
   ```
3. 发起一轮带工具调用的会话（让它读文件、跑命令）
4. 确认采集到记录：`ls ~/.loongsuite-pilot/logs/trae-cn/history/`
   没产出时看：`cat ~/.loongsuite-pilot/logs/trae-cn/errors/*.jsonl`
5. 刷新前端，prompt / 工具参数 / 工具结果 / 最终回答会出现在 span 详情里

覆盖的事件（官方共 6 个，全部注册）：`SessionStart`（会话起点）、`UserPromptSubmit`（prompt）、
`PreToolUse`（参数）、`PostToolUse`（结果）、`Stop`（最终回答）、`Notification`（`idle_prompt` 兼作轮次终止信号）。

> ⚠️ 官方的 `Stop` payload **只有 `last_assistant_message`**，没有 usage、没有思考过程、没有 finish_reason。
> 所以 hook 路径上 `gen_ai.usage.*` 恒为空，思考链本地根本拿不到（日志也没有）。

> ⚠️ **若你同时在用 Claude Code**：TRAE 设置里的「导入 CLAUDE 中的 Hooks 配置」开关会让 TRAE 一并读取
> `~/.claude/settings.json` 并合并执行——pilot 为 Claude Code 装的 hook 就在那里，开启后会在 TRAE 内被触发，
> 产出 `agent.type=claude-code` 的重复记录。验证本 demo 时建议先关掉该开关。

### schema 反推模式

若担心字段名猜错导致丢数据，可换成 demo 自带的原始捕获脚本：

```bash
node src/install-hooks.mjs /path/to/your/workspace --capture
```

`capture.mjs` 刻意做成 **schema 无关**：原样落盘 stdin 收到的一切到 `.data/hook-events.jsonl`，便于反推真实结构，再回头调 `parse-hook-events.mjs` / 处理器的候选字段表。两个源可共存，前端会合并展示。

### hooks.json schema（已按官方文档核对）

字段与事件名均来自官方文档，不再是从 `libai_agent.dylib` 字符串里猜的：
[Hook 配置参考](https://docs.trae.ai/ide/hook-configuration-reference?_lang=zh)（中文摘录见
[方案文档 §2.7](../../docs/zh-CN/trae-session-trace-path.md#27-trae-自带-hook-系统推荐主采集面)）。

`install-hooks.mjs` 生成的结构：

```json
{ "version": 1, "hooks": { "PreToolUse": [ { "matcher": "*",
  "hooks": [ { "type": "command", "command": "<trae-cn-loongsuite-pilot-hook.sh> PreToolUse", "timeout": 10 } ] } ] } }
```

官方约束（已在生成器里落实）：`version` 默认 1 且仅支持 1；`type` 当前仅支持 `command`（所以必须落盘中转，
不能直接 POST 到本地端点）；`matcher` 仅对 `PreToolUse` / `PostToolUse` / `Notification` 有效；
`timeout` 默认 30s（本 demo 收紧到 10s）；`loop_limit` 默认 5 且仅对 `Stop` 有效。

**配置没生效时**看 TRAE 自己的报错定位（也可直接看设置 > Hooks > 运行日志，但**退出 TRAE 后会被清空**）：

```bash
grep -aE "\[Hooks\]|\[HooksProvider\]" \
  ~/Library/Application\ Support/Trae\ CN/logs/*/Modular/ai-agent_*_stdout.log | tail -20
```

关键文案：`[HooksProvider] Failed to read hooks file`、`[Hooks] failed to resolve hooks config:`、`[Hooks] resolve_hooks_config result: is_ok=`

> ⚠️ **沙箱运行可能写不进 `~/.loongsuite-pilot/`**：设置 > Hooks > 运行方式 有「沙箱运行」与「本地自动运行」两种，
> 官方明确沙箱会限制文件访问。若 `history/` 始终无产出且 `errors/` 也是空的，先改成「本地自动运行」再试一轮。

## 安全设计

- **`capture.mjs` 永远 exit 0 并输出 `{"continue":true}`** —— `PreToolUse` 返回非零会**阻断 TRAE 的工具执行**，这是埋点最大的风险点
- 捕获时对 `ak`/`sk`/`token`/`secret`/`password`/`api_key`/`authorization` 等键做遮蔽（TRAE 日志中确实存在明文模型密钥）
- 工具输出单条上限 64KB，超出截断并标注总字节数
- 服务只监听 `127.0.0.1`，静态资源限制在 `web/` 目录内

## 已知限制

| 限制 | 说明 |
|------|------|
| LLM span 无 prompt/completion | TRAE 是云端架构，prompt 由服务端拼装（`svr__02_preprocess_build_llm_prompt`）。LLM span 只能是**性能 span**（有 TTFT / 网关 / SSE 拆解） |
| 非 RunCommand 工具结果依赖 hook | 这些工具在 `ai-agent` 进程内执行，结果只进加密库，无明文留存 |
| 思考过程本地不可得 | 日志无；官方 hook payload 也无（`Stop` 只给 `last_assistant_message`）。估计只在 SSE 流里透传给 UI |
| token 用量仅日志可得 | 官方 hook 无 usage 字段；只能靠日志的 `token_count`，且其 input/output/total 归属未明 |
| TOOL span 起点为估算 | 日志只给 `cost`，起点用 `end - cost` 反推；RunCommand 例外（用 `state.json` 的真实起止，属性 `trae.start_estimated=false`） |
| `jobs/` 会被清理 | 位于系统临时目录，不跨重启保留，需实时采集 |
| 单 session 串行样本 | 多 session 并发下 `trace_id` 是否仍 1:1 对应轮次未验证 |

## 环境变量

| 变量 | 默认 | 用途 |
|------|------|------|
| `TRAE_DEMO_PORT` | `8799` | 前端端口 |
| `TRAE_DEMO_SESSION_ID` | `6a82baade5152afe53a9612c` | 默认聚焦的 session |
| `TRAE_SUPPORT_DIR` | `~/Library/Application Support/Trae CN` | TRAE 数据目录 |
| `TRAE_JOBS_DIR` | 自动探测 `$TMPDIR/trae-agent-toolhost-<uid>/jobs` | job 落盘目录 |
| `TRAE_DEMO_DATA_DIR` | `$DEMO/.data` | hook 事件落盘位置 |

## 文件结构

```
$DEMO/
├─ hooks/capture.mjs            埋点入口：读 stdin JSON 原样落盘（永不阻塞 TRAE）
├─ src/
│  ├─ config.mjs                路径推导（按日志文件 mtime 选活跃日志）
│  ├─ parse-agent-log.mjs       流式解析 450MB 日志（含模块预筛）
│  ├─ parse-toolhost.mjs        toolhost.log + jobs/ 三级关联
│  ├─ parse-hook-events.mjs     hook 事件解析（多候选字段名探测）
│  ├─ build-trace.mjs           合成 ENTRY/AGENT/STEP/LLM/TOOL span 树
│  ├─ server.mjs                本地 HTTP 服务
│  ├─ cli.mjs                   命令行验证 + --doctor 自检
│  └─ install-hooks.mjs         生成 .trae/hooks.json
├─ web/index.html               Trace 瀑布图前端（纯原生，无构建）
└─ .data/hook-events.jsonl      捕获到的 hook 事件（运行时生成，已 gitignore）
```

## API

| 端点 | 说明 |
|------|------|
| `GET /` | 前端页面 |
| `GET /api/trace?session=<id>` | 构建并返回 span 树 JSON |
| `GET /api/hook-events` | 最近 200 条原始 hook 事件（用于反推 schema） |
