# TRAE CN 单轮 Session 完整 Trace 路径方案

> 本文是 TRAE CN 接入 LoongSuite Pilot 的**链路设计说明**，只描述方案，不含实现。
> 文中标注 `【实测】` 的部分来自本机 TRAE CN 1.10 运行日志的实际抽取；标注 `【待确认】` 的需要在真机补验。

## 1. 数据源结论

| 候选源 | 路径 | 结论 |
|--------|------|------|
| `ai-agent` 主库 | `~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db` | ❌ **SQLCipher 全库加密，不可读** |
| `ai-agent` 运行日志 | `~/Library/Application Support/Trae CN/logs/<启动时间戳>/Modular/ai-agent_0_<epoch_ms>_stdout.log` | ✅ **主源**：轨迹 / 时序 / 工具状态 |
| `toolhost` 日志 | `…/logs/<时间戳>/Modular/toolhost-host-*/toolhost.log` | ✅ **辅源**：job 真实 exit_code / 耗时 |
| `toolhost` job 落盘 | `/var/folders/<…>/T/trae-agent-toolhost-<uid>/jobs/job-<id>/` | ✅ **辅源**：RunCommand 参数 + 完整输出 |

> 本方案为**三源融合**：主源提供 span 骸架与时序，两个辅源仅用于补齐 `RunCommand` 类工具的参数/结果/真实起止（见 §2.5 / §2.6）。其余工具的结果与所有 LLM prompt **本地不可得**。

放弃 SQLite 的依据【实测】：

- 文件头为 `1822 43bf 3def 2014…`，非 `SQLite format 3`；`sqlite3` 返回 `file is not a database (26)`。
- `libai_agent.dylib` 内含 SQLCipher 专有符号：`PRAGMA cipher_page_size` / `cipher_kdf_algorithm` / `cipher_hmac_algorithm` / `SELECT sqlcipher_export('encrypted')`。
- 日志自证：`[DB] Database is already encrypted`。
- 技术栈为 Rust + sea-orm 1.1.4 + sqlx_sqlite + SQLCipher，密钥由进程内部持有。

> ⚠️ **禁止**将 `sqlite3` 或任何 SQLite 客户端指向该文件。实测中即使只是尝试打开（识别失败前），SQLite 仍会把 4.8 MB WAL checkpoint 进主库（wal 4845152→0，db +8192），属于对 TRAE 活动库的写入。

采用日志源的额外优势：纯文本、append-only、TRAE 自身已用 Rust `tracing` 做了全量埋点，`slardar_root` 为字节 APM 根 span —— **链路结构是现成的，不需要我们凭空构造语义**。

## 2. TRAE 侧原始事实

### 2.1 trace_id 与 turn 的关系（本方案的地基）

【实测】`trace_id` 长度**恒为 32 位 hex**，与 OTel `trace_id`（16 字节）格式**完全一致，可直接复用，无需哈希转换**。

【实测】**一轮对话 = 一个 trace_id**。样本日志 131,828 行中共 568 个 trace_id，其中 4 个带完整 chat 瀑布：

```
timing_events_713499b1a844a5b60a6eedae21a32aed_chat  rs_01_chat_begin=1786954120259
timing_events_9c128b778667e39a429046fd7a33b59d_chat  rs_01_chat_begin=1786954256481
timing_events_426415b16355d3533c76a59207edcbd3_chat  rs_01_chat_begin=1786954449425
timing_events_f92a6f05216df95daaed16af891e8d2a_chat  rs_01_chat_begin=1786955034643
```

工具调用通过同一 `trace_id` 归属到轮次【实测】：

```
Run tool SearchCodebase finished, status: Success, cost: 724ms  trace=713499b1
Run tool Grep          finished, status: Success, cost:  16ms  trace=713499b1
Run tool RunCommand    finished, status: Running, cost: 884ms  trace=713499b1
Run tool finish        finished, status: Success, cost:  28ms  trace=713499b1
Run tool LS            finished, status: Success, cost:  85ms  trace=9c128b77
Run tool Read          finished, status: Failed,  cost:  36ms  trace=9c128b77
```

### 2.2 TRAE 内部 span 路径（12 层）

【实测】`tracing` 的 span 路径即调用链，括号内为样本出现次数：

```
process_ipc_request → route → chat → do_chat → slardar_root → dispatch
  → execute_task → start → process_task → run_execution_task
    → do_create_cloud_agent_task → call_server_generate_plan_item
        ├─ start_agent_gen_plan              (337)
        ├─ apply_v3_variables_enrichment      (20)
        ├─ send_streaming                     (20)   ← LLM 流式调用
        └─ invoke → invoke_direct_ide        (300)   ← 工具调用
```

### 2.3 turn 内的 timing 瀑布

【实测】`ai_agent::infrastructure::common::timing` 输出有序检查点，含**绝对 epoch ms + 相对 delta**。全量事件字典（20 个）及单轮实例（trace `713499b1…`）：

| 事件 | epoch ms | delta | 含义 |
|------|----------|-------|------|
| `rs_01_chat_begin` | 1786954120259 | 0 | 轮次开始 |
| `rs_02_get_session` | …296 | 37 | 载入 session |
| `rs_03_get_history_message` | …297 | 1 | 载入历史消息 |
| `rs_04_create_message` | …298 | 1 | 创建用户消息 |
| `rs_06_get_custom_model` | …299 | 1 | 解析模型配置 |
| `rs_06_resolvers_begin` | …300 | 1 | 上下文收集开始 |
| `rs_06_resolver_browser_selection` | …301 | 1 | 子 resolver |
| `rs_06_resolver_user_message` | …302 | 1 | 子 resolver |
| `rs_06_resolver_websearch` | …303 | 1 | 子 resolver |
| `rs_06_resolver_terminal` | …304 | 1 | 子 resolver |
| `rs_06_resolver_log_message` | …305 | 1 | 子 resolver |
| `rs_06_resolve_contexts` | …321 | 16 | 上下文收集结束 |
| `rs_07_create_task` | …322 | 1 | 创建 task |
| `rs_08_create_turn` | …323 | 1 | 创建 turn |
| `rs_09_process_task` | …324 | 1 | 进入执行 |
| `rs_13_render_user_prompt` | …132442 | **12118** | 渲染 prompt（瓶颈） |
| `rs_15_before_generate_plan` | …132445 | 3 | 准备生成 |
| `rs_16_llm_generate_plain_item` | …132491 | 46 | LLM 请求发出 |
| `rs_18_llm_response_first_token` | …133984 | **1493** | 首 token（TTFT） |
| `rs_05_create_snapshot` | …133985 | 1 | 快照（乱序，见 §6.2） |

### 2.4 ID 体系

【实测】关联维度出现次数：`session_id` 13530、`tool_call_id` 3811、`message_id` 3810、`task_id` 3741、`toolcall_id` 260、`conversation_id` 26、`turn_id` 9。

两种 ID 形态并存，解析需兼容：

- **ObjectId 风格 24 位 hex**，前 8 位是 unix 秒，**自带时间戳，可作增量水位线**：
  `6a82baade5152afe53a9612c` → 2026-08-17 15:39:25
  `6a82c1a9e5152afe53a96182` → 2026-08-17 16:09:13（tool_call_id）
- **UUID 形态**：`a054c4cc-0bf8-45d8-8df6-5410b792ed33`

### 2.5 日志源的内容边界

> ⚠️ **本节结论仅适用于「日志源」。LLM prompt 与最终回答可通过 TRAE 自带的 Hook 系统获取（详见 §2.7）；思考过程 hook 同样不提供。**

【实测】`ai-agent` stdout 日志以轨迹与时序为主，但**工具结果并不缺失**（见下表最后两行与§2.5.1）：

| 数据 | 日志源可得性 | 依据【实测】 |
|------|-----------|------|
| 轨迹 / span 路径 / 时序 | ✅ 完整 | §2.2 / §2.3 |
| 工具名 / 状态 / 耗时 | ✅ 完整 | `Run tool <Name> finished, status: …, cost: …ms` |
| ReAct 迭代边界 | ✅ 完整 | `[commit_toolcall_result] endpoint=`（§2.5.1） |
| RunCommand 命令原文 + 输出 + exit_code | ✅ 完整（§2.6） | `state.json` + `output.log` |
| 其他工具**参数** | ⚠️ 仅失败时 | 全日志仅 3 次 `failed, params:` |
| 其他工具**结果** | ✅ 完整 | 提交载荷里的 `toolcall_resp`（§2.5.1） |
| **LLM prompt / 思考过程** | ❌ 日志中无 | `system_prompt`=0、`"role"`=0、`role:`=0 |

#### 2.5.1 工具结果与迭代边界的真正位置【实测，纠正前版结论】

早先“日志中无工具结果”的结论是**搜错了关键字**（找的是 `result` / `output` / `stdout`）。真实字段名叫 `toolcall_resp`：

```
[commit_toolcall_result] endpoint=… {…"toolcall_id":"call_UddyEtHM3iAO3Eej5VVL9Iny",
  "toolcall_name":"TodoWrite","toolcall_resp":"Todos have been modified successfully…"}
```

客户端把工具结果回传服务端时必然把正文带上，所以这行既是**非 RunCommand 工具结果在本地的唯一来源**，
也是**ReAct 迭代边界**（提交即本次迭代结束、服务端开始生成下一步）。已在 demo 上验证：
单轮取到 `SearchCodebase` 272B / `Glob` 2768B / `Glob` 8023B / `LS` 5970B 等真实结果（每行恰好 1 个 `toolcall_resp`）。

> ⚠️ 结果可达 32KB+（过大时 TRAE 自身会换成 `<persisted-output>` 引用临时文件），采集必须截断，并受 `captureMessageContent` 控制。


prompt 不入日志的原因是**云端 Agent 架构**：服务端 timing 字段自证 prompt 在服务端拼装，客户端只上传上下文引用：

```
svr__02_preprocess_build_llm_prompt : 0      ← prompt 由服务端拼装
svr_02_gateway_preprocess_timing    : 47
svr_02_preprocess_timing            : 195
svr__04_postprocess_security_check  : 66
svr_06_platform_first_token_timing  : 1130
svr_10_first_sse_event_timing       : 1186
svr_11_server_processing_time       : 1401
svr_11_gateway_server_processing_time: 1258
svr_09_middleware_processing_timing : 8
svr_11_cloud_agent_postprocessing   : 0
```

【实测】且无法通过调高日志级别补救：`libai_agent.dylib` 中不存在 `RUST_LOG` / `*_LOG_LEVEL` / `AI_AGENT_*` 级别开关，也无 `dump_prompt` / `log_prompt` 类开关。

> 推论：`Read`/`Grep`/`Glob`/`LS`/`SearchCodebase` 由 `ai-agent` 进程内直接执行（`toolhost` 只处理 `terminal` 166+55 次与 `browser` 1 次），**不经过 toolhost 落盘**；但它们的结果仍会在回传服务端时经 `commit_toolcall_result` 写入日志（§2.5.1）。

### 2.6 RunCommand 工具结果的完整来源

【实测】终端类工具经 `toolhost` 的 job executor 执行，每个 job 独立落盘：

```
/var/folders/<...>/T/trae-agent-toolhost-<uid>/jobs/job-<job_id>/
  ├─ state.json    ← 状态元数据（见下）
  ├─ output.log    ← 命令完整输出（即工具结果）
  ├─ cwd.txt       ← 工作目录
  └─ .exited       ← 完成标记
```

样本目录含 **54 个 job**。`state.json` 结构完整：

```json
{
  "status": "Exited",
  "exit_code": 0,
  "pid": 39645,
  "command": "cat ~/Library/.../alog.log | head -100",
  "cwd": "/Users/zhaowenbo/Terminal-TRAE",
  "created_at": 1786954272,
  "started_at": 1786954272,
  "finished_at": 1786954272
}
```

关联链路【实测】：`ai-agent` 日志的 `[RunCommand] command completed, command_id: job-e171343b…`
→ `toolhost.log` 的 `Native async host job completed job_id=job-e171343b… exit_code=0 execution_duration_ms=455`
→ `jobs/job-e171343b…/{state.json,output.log}`

> 该链路同时**解决 §6.1 的 `Running` 状态问题**：`state.json` 的 `finished_at` 与 `exit_code` 给出工具的真实结束时间与成败。

### 2.7 TRAE 自带 Hook 系统（推荐主采集面）

【官方文档】TRAE 内置 Hook 系统，与 Claude Code **高度同构但不等同**（官方明确提示同名事件的输入输出可能有差异）。
本节全部以官方文档为准：

- [通过 Hook 实现自动化](https://docs.trae.ai/ide/automate-actions-with-hooks?_lang=zh)
- [Hook 配置参考](https://docs.trae.ai/ide/hook-configuration-reference?_lang=zh)

> 本节此前基于 `libai_agent.dylib` 字符串提取（模块路径 `domain/hooks/{config/parser,executor/http_executor,instance/trigger,env_file,enterprise/api_client}.rs`）推断，
> 经官方文档核对后**有三处结论是错的**，已在下文逐条标注 ⚠️ 更正。dylib 依据仅在官方文档未覆盖处保留。

#### 事件类型（6 个）【官方文档】

| 事件 | 触发时机 | 对本方案的价值 |
|------|---------|----------------|
| `SessionStart` | 创建 Session 后、发起第一个对话前 | 会话起点；可向 `$TRAE_ENV_FILE` 写环境变量（上游 trace 关联的天然落点） |
| `UserPromptSubmit` | 用户发送 Query 后、智能体开始处理前 | 用户 **prompt** |
| `PreToolUse` | 智能体发起工具调用后、实际执行前 | 工具**参数** + `tool_use_id` |
| `PostToolUse` | 工具调用实际执行完成后 | 工具**结果** |
| `Stop` | 智能体完成输出、准备结束当前 Query 时 | 轮次结束边界 + **最终回答正文** |
| `Notification` | 工具等待用户确认时，或任务完成时。**异步触发，不阻塞主流程** | 辅助事件，按 `notification_type` 区分场景 |

> ⚠️ **更正 1**：前版按 dylib 字符串只列出 5 个事件，**漏了 `SessionStart`**。

#### 配置文件位置【官方文档】

| 作用域 | 路径 |
|--------|------|
| 全局（当前用户的所有工作区） | `~/.trae-cn/hooks.json`（Windows：`%userprofile%/.trae-cn/hooks.json`） |
| 项目（当前工作区） | `$PROJECT_FOLDER/.trae/hooks.json`；工作区含多个项目时默认建在第一个项目 |
| Claude Code 全局 | `~/.claude/settings.json` |
| Claude Code 项目 | `$PROJECT_FOLDER/.claude/settings.json`、`$PROJECT_FOLDER/.claude/settings.local.json` |

多份配置**合并执行**：工作区内多个项目根各自的项目级配置同时生效；打开「设置 > Hooks > 导入 CLAUDE 中的 Hooks 配置」后，Claude Code 的配置也一并读取并合并。

> ⚠️ **跨 Agent 重复采集风险（本项目专有，此前完全没识别到）**：本项目为 Claude Code 部署的 hook 就写在 `~/.claude/settings.json`。
> 用户一旦打开上述导入开关，**pilot 的 claude-code hook 会在 TRAE 内被触发**，产出 `gen_ai.agent.type=claude-code`
> 的记录——既重复计数，又把 TRAE 的活动归到错误的 Agent 上。TRAE 接入必须处理这一条（见 §8）。

> 企业级下发（`/api/ide/enterprise-hooks/config`、`[EnterpriseHooks] fetcher started for tenant:`）仅见于 dylib 字符串，**官方文档未提及**，不作为方案依据。

#### 配置格式【官方文档】

```json
{
  "version": 1,
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<ToolPattern>",
        "loop_limit": 5,
        "hooks": [
          { "type": "command", "command": "<shell command>", "timeout": 30 }
        ]
      }
    ]
  }
}
```

| 层 | 字段 | 必填 | 说明 |
|----|------|------|------|
| 顶层 | `version` | 否 | schema 版本，默认 `1`，**当前仅支持 `1`** |
| 顶层 | `hooks` | 是 | 事件名 → Hook 组列表 |
| Hook 组 | `matcher` | 否 | 正则（如 `Edit\|Write`、`mcp.*`）；`*`/空/省略 = 匹配全部。**仅对 `PreToolUse` / `PostToolUse` / `Notification` 有效** |
| Hook 组 | `loop_limit` | 否 | 默认 `5`；`loop_count ≥ loop_limit` 时跳过该组。**仅对 `Stop` 有效** |
| Hook 组 | `hooks` | 是 | 该组要执行的 Hook 列表 |
| Hook 定义 | `type` | 否 | 默认 `command`，**当前仅支持 `command`** |
| Hook 定义 | `command` | 是 | 要执行的 Shell 命令 |
| Hook 定义 | `timeout` | 否 | 超时秒数，默认 `30` |

> ⚠️ **更正 2**：前版称「HTTP 执行器可直接 POST 到本地端点，无需落盘中转」（依据 dylib 的 `http_executor.rs`）。
> 官方明确 `type` **当前仅支持 `command`**，该路径不可用 —— **落盘中转是唯一方案**，§2.9 的实现方向是对的。

#### stdin 字段【官方文档】

通用字段（所有事件都有）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | `string` | 当前会话 ID |
| `cwd` | `string` | hook 命令的实际工作目录（= 工作区/项目根，见下文「执行环境」） |
| `hook_event_name` | `string` | 当前事件名 |
| `workspace_roots` | `string[]` | 多工作区时包含全部工作区根目录 |

> ⚠️ **没有 `transcript_path`，也没有任何 trace / turn / message / task id** —— 这是与 Claude Code 的关键差异，
> **直接印证了 §2.9 必须由处理器自维护轮次状态**（不是权宜之计，而是唯一可行做法）。

各事件专有字段：

| 事件 | 专有字段 |
|------|---------|
| `SessionStart` | `source`（当前仅 `startup`） |
| `UserPromptSubmit` | `prompt` |
| `PreToolUse` | `tool_use_id`、`tool_name`（标准化名）、`llm_tool_name`（传给模型的原始名）、`tool_input`（object） |
| `PostToolUse` | 同 `PreToolUse` + `tool_response`（object） |
| `Stop` | `stop_hook_active`（bool）、`loop_count`（number，被阻断次数，从 0 累加）、`last_assistant_message`（string，模型最终输出正文） |
| `Notification` | `notification_type`、`message`（通知正文）、`tool_use_id?`（仅工具类通知携带） |

`notification_type` 取值：`idle_prompt`（任务完成）、`permission_prompt`（需用户确认，含 `PreToolUse` 返回 `ask` 的情况）、`document_review`（Plan/Spec 文档审阅）、`ask_user_question`、`browser_interaction`。

> ⚠️ **更正 3（影响最大）**：`Stop` 的 payload **只有** `stop_hook_active` / `loop_count` / `last_assistant_message` ——
> **没有 usage / token 数，没有 reasoning 思考过程，没有 finish_reason**。前版按 Claude Code 类推的「Stop 给 usage + 思考过程」
> 不成立，§2.9 与 §4.2 已据此更正：思考过程本地**任何来源都拿不到**，usage 只能回落到日志的 `token_count`（§8 待确认项 1）。

#### stdout 与退出码【官方文档】

通用流程控制（所有事件）：`{"continue": bool, "stopReason": string}`，`continue=false` **优先于**任何事件级 `decision`。

事件级输出：

- `UserPromptSubmit` / `PostToolUse` / `Stop`：`decision`（仅支持 `"block"`，留空 = 放行）+ `reason`
- `SessionStart` / `UserPromptSubmit` / `PostToolUse` / `PreToolUse`：`hookSpecificOutput.{hookEventName, additionalContext}`
- `PreToolUse` 另有 `permissionDecision`（`allow` / `deny` / `ask`；多个 hook 并行时优先级 `deny` > `ask` > `allow`）、`permissionDecisionReason`、`updatedInput`（**整体覆盖**原参数，非合并）
- `SessionStart` / `UserPromptSubmit` 还接受**纯文本** stdout，直接作为附加上下文给模型
- `Notification` **忽略 stdout**

| 退出码 | 行为 |
|--------|------|
| `0` | 正常。stdout 按事件类型解析为 JSON 或纯文本 |
| `2` | **阻断性错误**。stderr 进模型上下文；各事件语义不同（`PreToolUse` = `deny`、`UserPromptSubmit`/`Stop` = `block`、`PostToolUse` = 仅传上下文、`SessionStart`/`Notification` = 不影响流程） |
| 其他 | 非阻断。stdout / stderr **均被忽略**，不影响执行流程 |

> 对采集器的含义：**唯一危险的退出码是 `2`**。§2.9 恒 `exit 0` + `{}`（无决策 = 放行）比「其他非零」更保守，安全边界成立。

#### 执行环境【官方文档】

- **Shell**：macOS/Linux → Bash；Windows → PowerShell
- **环境变量**：`TRAE_PROJECT_DIR`、`CLAUDE_PROJECT_DIR`（均等于 `stdin.cwd`）；`SessionStart` 额外注入 `TRAE_ENV_FILE`、`CLAUDE_ENV_FILE`
- **环境变量文件**：`SessionStart` 的 hook 可向 `$TRAE_ENV_FILE` 写入变量（支持 Bash `export` / PowerShell `$env:` / dotenv 三种格式），对**后续 hook 执行与 `RunCommand` 工具调用**生效，但不影响当前 SessionStart 进程
- **工作目录**：全局 hook → 单工作区取该工作区根、多工作区取第一个；项目 hook → 该配置文件所在项目根
- **运行方式**（设置 > Hooks > 运行方式，二选一）：**沙箱运行**（文件访问与系统权限受沙箱限制）/ **本地自动运行**（沙箱外，官方标注风险）
- **运行日志**：设置 > Hooks > 运行日志 → 输出面板 "Agent Hooks"；**退出 TRAE 后当前周期日志被清空**

> ⚠️ **沙箱写权限必须实测**：处理器要写 `~/.loongsuite-pilot/logs/trae-cn/`。若默认「沙箱运行」禁止越出工作区写入，
> 埋点会**静默失败**（错误日志也写不进去，且 TRAE 侧运行日志退出即清）。见 §8 待确认项。

#### 标准化工具名【官方文档】

`PreToolUse` / `PostToolUse` 的 `tool_name` 是标准化名称，`matcher` 按它做正则匹配：

| 分类 | 工具名 |
|------|--------|
| 文件 | `Read`、`Write`、`Edit` |
| 搜索 | `Glob`、`Grep`、`LS` |
| 终端 | `RunCommand` |
| 网络 | `WebSearch`、`WebFetch` |
| 交互 | `AskUserQuestion` |
| Skill | `Skill` |
| MCP | `mcp__<serverName>__<toolName>`（`mcp__.*` 匹配全部 MCP 工具） |

原始工具名在 `llm_tool_name` 里另给一份。

> ⚠️ 该清单**不含 §2.1 / §2.5.1 日志里实测出现的 `SearchCodebase`、`TodoWrite`、`finish`**。
> 若这些工具确实不触发 hook，则 hook 覆盖不到全部 TOOL span，**日志源的 `toolcall_resp` 不可替代**（见 §8）。

### 2.8 加密库的真实表结构（侧面证据）

【实测】dylib 内嵌的 SQL 语句泄露了加密库 schema，证实**对话内容确实保存在本地**（只是被加密）：

```sql
chat_message      (session_id, message_id, message_type, message_role, message_index, …)
                  -- SELECT session_id FROM chat_message WHERE message_type = 'chat'
chat_session      (…)  -- JOIN chat_session cs2 ON cm.session_id = cs2.session_id
history_v2        (history_v2_id, session_id, message_id, messages, token_usage, …)   ← 完整消息 + token
chat_session_goal (session_id, goal_id, objective, status, tokens_used,
                   time_used_seconds, rounds_used, …)
history_todo_list (session_id, message_id, history_v2_id, todo_list_id, …)
未命名轮次表   (session_id, turn_id, agent_type, additional_context, …)
未命名任务表   (task_id, session_id, message_id, status, summary, …)
```

**数据流向结论**：

```
TRAE 服务端 ==SSE==> ai-agent (Rust，持有密钥) ==IPC==> Electron 渲染进程 ==> UI 渲染
                              |
                              +--写入--> SQLCipher 加密库（history_v2.messages）
```

【实测】UI 通过 IPC 向 `ai-agent` 拉取内容，而非读取本地明文：`chat` 路由 10023 次（流式通道）、`get_sessions` 16 次、`get_multi_by_session_id` 2 次。

【实测】**以下明文位置已排查，均不含对话内容**：

- `User/globalStorage/state.vscdb`（明文 SQLite，96 个 key）：`chat.ChatSessionStore.index` = `{"version":1,"entries":{}}` **为空**；`ai-chat.chatQueryCompletion.v1.<session_id>` 仅存模型推荐的追问问题
- `Local Storage/leveldb`（552K）：`tool_result` / `thinking` / `reasoning` / `toolCall` / `mcp` 均 **0 命中**
- `IndexedDB` / `blob_storage`：**空**
- `ModularData/ai-agent/snapshot/<session_id>/v2/.git/`：是工作区文件快照（git 仓，用于回滚 diff），**不含对话**

> 所以「前端能看到所以本地能查到」成立，但**载体是加密库 + 瞬时 IPC，不是任何明文文件**。要拿到内容，正规路径是 §2.7 的 Hook 系统（官方支持、版本稳定），而不是解密数据库（需厂商密钥、随版本易失效）或拦截 IPC（侵入式、易碎）。

### 2.9 Hook 埋点实现（已落地，字段已对齐官方文档）

Hook 处理器已完成并通过仓库 validator 验证：

| 产物 | 路径 |
|------|------|
| 处理器 | `assets/hooks/trae-cn-hook-processor.mjs` |
| Shell 包装器 | `assets/hooks/trae-cn-loongsuite-pilot-hook.sh` |
| 产出 | `~/.loongsuite-pilot/logs/trae-cn/history/trae-cn-YYYY-MM-DD.jsonl` |
| 注册器 | `demo/trae-trace-demo/src/install-hooks.mjs` → `<工作区>/.trae/hooks.json` |

#### 埋点时机 → GenAI 事件名

| TRAE 事件 | `event.name` | 携带的关键内容 |
|-----------|--------------|----------------|
| `SessionStart` | `other` | 会话起点标记（`agent.trae.source`），不开轮次 |
| `UserPromptSubmit` | `llm.request` | `gen_ai.input.messages`（user/text part）+ `messages_hash` |
| `PreToolUse` | `tool.call` | `gen_ai.tool.call.arguments`（`tool_input`） |
| `PostToolUse` | `tool.result` | `gen_ai.tool.call.result`（`tool_response`）+ `tool.result.status` |
| `Stop` | `llm.response` | `gen_ai.output.messages`（**仅 text part**，源 `last_assistant_message`） |
| `Notification` | `other` | 上下文保留；`idle_prompt` 额外作为**轮次真正结束**的信号 |

> ⚠️ `Stop` **拿不到 usage / reasoning / finish_reason**（§2.7 更正 3）。处理器里这三组字段的候选探测会全部落空，
> 因此：`gen_ai.usage.*` 在 hook 路径上**恒为空**（需日志的 `token_count` 补），`finish_reasons` 恒为 `['stop']`（白名单兼容默认值）。
> 保留多候选探测是为了 TRAE 后续版本补字段时无需改码，不是当下有数据。

#### 轮次与 step 串联机制

TRAE 的 hook payload **经官方文档确认不携带任何 trace / turn / message id**（§2.7），因此处理器自维护每 session 的轮次状态（`state/trae-cn/turns/<session>.json`）：

```
SessionStart      → 不开轮次（会话起点标记）
UserPromptSubmit  → 开新轮，生成 traceId + turnId，step.id = <turnId>:s1
PreToolUse        → 复用同一 traceId 与同一 step.id；若上一批已回结果则 tool_batch++
PostToolUse       → 按 tool_use_id 回到它的 PreToolUse 所属批次
Stop              → 同一 step.id 收尾，但**不清状态**（可能被其他 hook 阻断后重入）
Notification(idle_prompt) → 任务真正完成，清除轮次状态
```

**为何不在 `Stop` 清状态**：官方的 `loop_count` / `stop_hook_active` / `loop_limit`（默认 5）说明
**一轮可能触发多次 `Stop`**——任何一个用户自己的 Stop hook 返回 `block`，智能体就会继续干活，
之后再发一次 `Stop`（`loop_count` 递增）。若在第一次 `Stop` 就清状态，中间那批工具与第二次 `Stop`
会被当成新轮次（`turn_synthesized=true`），**同一轮对话被拆成两条 trace**。
改用官方语义上真正的终止信号 `Notification.notification_type = idle_prompt`（智能体完成当前任务）收尾；
并保留两道兼容：`UserPromptSubmit` 总是强制开新轮（不依赖旧状态），且轮次状态超过 12 小时视为过期。

**为何一轮只给一个 step（而不是每个事件一个）**：`gen_ai.step.id` 的语义是「一次 ReAct 迭代」，
下游按它组成 `STEP{ LLM, TOOL... }`，且每个 STEP 必须恰好 1 个 LLM（`scripts/validate-trace.mjs` 强制，见 §3.2）。
hook 只在轮次首尾给出模型信号（UserPromptSubmit / Stop），中间每次推理未暴露，
若按事件自增 step，会把同一次调用的 `tool.call` / `tool.result` 拆到两个 step，
把 `llm.request` / `llm.response` 拆到首尾两个 step，产出一堆**没有 LLM 的破碎 STEP**。

真实观测到的迭代结构仍保留在 `agent.trae.tool_batch`（PreToolUse 出现在 PostToolUse 之后 = 又发生了一次推理），
待与 §2.5.1 的日志迭代边界融合后可直接升级为逐迭代 step。

中途启动（没收到 `UserPromptSubmit` 就先收到 `PreToolUse`）时**惰性补一个轮次而不丢事件**，并标记 `agent.trae.turn_synthesized=true`，便于下游区分完整轮次与碎片轮次。

#### 关键归一化规则

| 规则 | 实现 | 原因 |
|------|------|------|
| `tool.result.status` | `exit_code` **优先于** 文字状态 | TRAE 的 `RunCommand` 常返回 `Running`（异步下发已返回，非最终态），只有 `exit_code` 才是真实成败 |
| `provider.name` | `bytedance.doubao` | 规范要求无标准值时用小写 dotted 名称（对标 `baidu.ernie`） |
| `finish_reason` | 按 `scripts/validate-trace.mjs` 的 `VALID_FINISH_REASONS` 白名单 | 该集合是接入验收**实际强制**的，越界报 error；它不含 docs 提到的 `cancelled`，故中断类归一到 `stop`，原值另存 `agent.trae.finish_reason_raw` |
| 思考过程 | `parts[].type = 'reasoning'`（代码就绪但**当下恒无数据**） | 与仓库既有 Agent（Qoder / Claude Code）一致；TRAE 官方 payload 不提供思考过程（§2.7 更正 3），保留实现仅为未来兼容 |
| 未映射字段 | 全量挂 `agent.trae.*` | 保留原始信息（`workspace_roots` / `llm_tool_name` / `loop_count` / `notification_type` / `message` 等均由此自动落盘） |

字段读取仍走**多候选探测**，但候选表已改为**官方字段名优先**（`tool_use_id` / `tool_response` / `last_assistant_message` / `prompt` / `cwd`），
camelCase 与旧猜测名仅作向后兼容。特别地：`message` 已从 prompt / error 候选里**移除**——它是 `Notification` 的通知正文，
留在候选表里会让它被归入已映射集而**静默丢失**。

#### Fail-open 底线

处理器与包装器**永远 `exit 0` 并输出 `{}`**（无决策 = 放行）。这不是可选项：`PreToolUse` 返回非零或 block 决策会**直接卡住 TRAE 的工具执行**。异常写入 `logs/trae-cn/errors/`，不向宿主传递。

#### 验证结果

- 8 个事件（prompt / 2 并行工具一批 / RunCommand 二批 / Stop）全部 `exit=0` / `stdout={}`，零错误日志
- 同一轮 8 条记录共享 1 个 `trace_id` / `turn.id` / `step.id`（8 个独立 `span_id`），
  `tool.call` 与对应 `tool.result` 按 `tool_call_id` 落在同一 `agent.trae.tool_batch`（并行两个工具=batch 1，结果回传后的 RunCommand=batch 2）
- 仓库真实 validator（`validateMessageField`）：**0 error / 0 warn**，必填字段无缺失
- 时间戳落在真实 turn 窗口内时，demo 能把 prompt / 思考过程 / 工具结果正确合并进 span 树

> → 这直接填上了 §2.5 表中仍标为「❌ 日志中无」的 **LLM prompt**（`UserPromptSubmit`）与**最终回答**（`Stop`）；
> 工具结果已由 §2.5.1 的日志源自行解决，hook 仅作为更及时的补充。
> **思考过程仍无解**：日志没有，hook 官方 payload 也没有（§2.7 更正 3）——下游看板如需思考链，TRAE 场景无法支持，需提前对齐预期。

## 3. 完整 Trace 路径方案

### 3.1 核心决策

| 决策 | 取值 | 理由 |
|------|------|------|
| trace 粒度 | **一轮 turn = 一条 trace** | 与本项目 ENTRY 即 turn 根 span 的既有约定一致；且 TRAE trace_id 天然按轮次划分 |
| trace_id 来源 | **直接复用 TRAE 的 32 位 hex trace_id** | 格式天然兼容，且能与 TRAE 自身 Slardar 链路对齐排查 |
| span_id 来源 | **采集侧合成** | ⚠️ 日志只有 span **名字**，不含 span_id；父子关系由 span 路径字符串推导 |
| Session 关联 | 跨 trace 靠 `gen_ai.conversation.id` 属性 | 一个 session 含多轮，不合并成单条 trace |
| TRAE 12 层内部 span | **压缩到 5 类** | 原样导出会污染链路且不符合 GenAI semconv |
| **STEP 粒度** | **一次 ReAct 迭代 = 一个 STEP** | 仓库强制：STEP 的父必须是 AGENT，LLM/TOOL 的父必须是 STEP，且每个 STEP 恰好 1 个 LLM |
| 迭代边界 | `[commit_toolcall_result]` | 提交工具结果即本次迭代结束、服务端开始生成下一步（§2.5.1） |
| 准备阶段（上下文收集 / prompt 渲染） | **AGENT 上的 span event** | 它们没有 LLM 调用，建成 STEP 会违反「每个 STEP 恰好 1 个 LLM」 |

### 3.2 目标 span 树

层级约定来自 `scripts/update-validation-rules.mjs` 的 `SPAN_KIND_META`，由 `scripts/validate-trace.mjs` 强制：

| 规则 | 含义 |
|------|------|
| `structure.step_under_agent` | STEP 的父必须是 AGENT（不得 STEP 嵌 STEP）|
| `structure.llm_under_step` / `tool_under_step` | LLM / TOOL 的父必须是 STEP（不得直挂 AGENT）|
| `structure.step_has_one_llm` | 每个 STEP **恰好 1 个** LLM 子 span |
| `structure.llm_before_tools` | STEP 内 LLM 必须不晚于所有 TOOL 开始 |
| STEP 之间无时间重叠 / 末 STEP 的 LLM 无 tool_call | 迭代串行，最后一次推理给出最终回答 |

所以轨迹是**「推理 → 该次推理下发的工具 → 再推理」的迭代序列**，而不是「先一排 STEP、再一排 TOOL」。
以实测 trace `713499b1…`（demo 真机跑出，7 迭代 / 11 工具 / 42.2s）为例：

```
trace_id = 713499b1a844a5b60a6eedae21a32aed          ← 复用 TRAE trace_id
│
└─ ENTRY  "enter_ai_application_system"            42.18s  [rs_01_chat_begin → 轮次结束]
   └─ AGENT "invoke_agent trae-cn"                  42.18s  span event: context.resolve.* / prompt.render.end
      │
      ├─ STEP "react step"                          4.88s   round=1  边界=commit_toolcall_result
      │  ├─ LLM  "chat aliyuncs//qwen3.7-max"        3.92s   TTFT=1493ms（rs_18 作为 span event）
      │  ├─ TOOL "execute_tool SearchCodebase"        724ms  结果 272B
      │  └─ TOOL "execute_tool Grep"                   16ms  结果 16B（同一次推理并发下发）
      │
      ├─ STEP "react step"                          3.11s   round=2
      │  ├─ LLM  "chat aliyuncs//qwen3.7-max"        2.92s   起点 = 上一迭代的 commit
      │  ├─ TOOL "execute_tool Grep"                   12ms
      │  └─ TOOL "execute_tool LS"                     89ms
      │
      ├─ … round=3、4、5（Glob / LS）…
      │
      ├─ STEP "react step"                          5.72s   round=6
      │  ├─ LLM  "chat aliyuncs//qwen3.7-max"        4.84s
      │  └─ TOOL "execute_tool RunCommand"           858ms  结果取 toolhost output.log
      │
      └─ STEP "react step"                          4.49s   round=7  边界=turn_end
         ├─ LLM  "chat aliyuncs//qwen3.7-max"        4.46s   最终回答（Stop hook 补内容）
         └─ TOOL "execute_tool finish"                28ms  ← 轮次终结标记
```

span 名一律跟仓库 `SPAN_KIND_META` 的 `namePattern`：ENTRY `enter_ai_application_system`、
AGENT `invoke_agent {agent}`、STEP `react step`、LLM `chat {model}`、TOOL `execute_tool {tool}`。

若只有 hook 数据而无日志（拿不到迭代边界），则退化为**一轮 1 个 STEP**：
首尾两条模型信号配成唯一 LLM span，工具作为其兄弟（见 §2.9）——结构合法但丢迭代保真度，
因此生产采集建议**日志（迭代骨架）+ hook（内容）融合**。

### 3.3 TRAE span 路径 → span kind 折叠规则

| TRAE span 路径片段 | 折叠为 | 说明 |
|-------------------|--------|------|
| `process_ipc_request` / `route` | **丢弃** | IPC 传输层，非语义节点 |
| `chat` / `do_chat` | **ENTRY** | 轮次入口 |
| `slardar_root` | **丢弃** | 字节 APM 埋点锚，与我们的 trace 根重复 |
| `dispatch` / `execute_task` / `start` / `process_task` / `run_execution_task` | **AGENT**（合并为一个）| 5 层纯调度嵌套，无独立语义，压成单个 AGENT |
| `do_create_cloud_agent_task` / `call_server_generate_plan_item` | **AGENT**（同上合并）| 同为调度层 |
| `start_agent_gen_plan` | **AGENT 的 span event** `prompt.render.end` | 计划生成准备，无 LLM 调用，不能当 STEP |
| `apply_v3_variables_enrichment` | **AGENT 的 span event** `context.enrich` | 变量注入，同上 |
| `send_streaming` | **LLM**（挂当前 STEP 下）| 模型流式调用；实测单轮多次，**每次开一个新 STEP** |
| `invoke` / `invoke_direct_ide` | **TOOL**（挂当前 STEP 下）| 工具执行，归属于下发它的那次推理 |
| `[commit_toolcall_result]`（日志行，非 span）| **STEP 边界** | 提交结果 → 当前 STEP 关闭，下一条日志开新 STEP |

> ⚠️ 实测踩坑：`rs_16_llm_generate_plain_item` 在**单个 trace 内会出现多次**（样本 trace `c22c7104…` 出现 7 次，
> `rs_13` / `rs_18` 各 8 次）。只取第一条会把多次推理压成一个 LLM span，必须取全部并逐迭代匹配。

> 折叠掉的 12 层原始路径建议保留在 ENTRY span 的 `trae.span.path` 属性中，便于回溯排查，不参与树形结构。

## 4. span 属性映射

沿用本项目既有 `gen_ai.*` 约定（见 [输出事件 Schema](output-event-schema.md)、[Trace 输出](trace-output.md)）。

### 4.1 ENTRY / AGENT（轮次级）

| 属性 | 来源 |
|------|------|
| `gen_ai.span.kind` | `ENTRY` / `AGENT` |
| `gen_ai.conversation.id` | `session_id`（ObjectId 或 UUID 两种形态） |
| `gen_ai.agent.name` | `agent_type`，实测取值 `solo_agent` |
| `gen_ai.system` | 固定 `trae-cn` |
| `gen_ai.request.model` | `model_info.model_name`，实测 `aliyuncs//qwen3.7-max` |
| `gen_ai.response.model` | `display_model_name`，实测 `Qwen3.7-Max` |
| `trae.task.id` | `task_id` |
| `trae.turn.id` | `turn_id`【待确认】样本仅 9 次，可能非稳定字段 |
| `trae.message.id` | `message_id` |
| `trae.trace.id` | TRAE 原始 trace_id（冗余留存便于比对） |
| `workspace.path` / `git.*` | 由本项目 Git 上下文增强模块自动注入 |

### 4.2 LLM span

每个 ReAct 迭代一个 LLM span（不是一轮一个）。

| 属性 | 来源 |
|------|------|
| `gen_ai.span.kind` | `LLM` |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.request.model` | 同上 |
| `gen_ai.react.round` | 该迭代序号（1 起） |
| 迭代 1 的 span 起点 | `rs_16_llm_generate_plain_item` |
| 迭代 i>1 的 span 起点 | 上一迭代的 `commit_toolcall_result` 时刻（提交结果即下次推理开始） |
| span 终点 | 本迭代首个工具的开始时刻；无工具（末次推理）时取轮次结束 |
| `gen_ai.usage.input_tokens` / `output_tokens` | 【待确认】日志仅见 `token_count=Some(N)`（实测值 1145 / 1412 / 8079 等），**归属未明**；⚠️ hook 的 `Stop` 事件**不提供 usage**（§2.7 更正 3），日志是唯一来源 |
| span event `llm.first_token` | 落在**本迭代窗口内**的 `rs_18_llm_response_first_token`（窗口外的是过期值，丢弃） |
| `gen_ai.provider.name` | `model_info.provider`，实测 `aliyuncs` |
| `gen_ai.input.messages` | ❌ 日志恒空，prompt 服务端构建（§2.5）；轮次首次推理可由 `UserPromptSubmit` hook 补齐 |
| `gen_ai.output.messages` | ❌ 中间迭代恒空；**末次迭代**由 `Stop` hook 补齐（**仅 text part**，无 reasoning） |
| 服务端耗时拆解 | `svr_*` 是**轮次级聚合**（日志收尾才输出一次），只挂首次推理并标 `trae.svr.scope`，不得逐迭代重复 |

> **LLM span 的定位**：TRAE 场景下中间迭代的 LLM span 只能是「**性能 span**」而非「**内容 span**」——有完整的时延拆解（TTFT、网关、预处理、SSE），但没有 prompt/completion；只有**首次（用户 prompt）与末次（最终回答）**能由 hook 补内容，且回答只有正文、没有思考链。若下游看板需要逐迭代的思考链，TRAE 无法支撑，需提前对齐预期。

### 4.3 TOOL span

| 属性 | 来源【实测】 |
|------|------|
| `gen_ai.span.kind` | `TOOL` |
| 父 span | 下发它的那次推理所在的 **STEP**（不是 AGENT） |
| `gen_ai.tool.name` | `Run tool <Name>` → `SearchCodebase` / `Grep` / `Glob` / `LS` / `Read` / `RunCommand` / `finish` |
| `gen_ai.tool.call.id` | `tool_call_id` / `toolcall_id`（ObjectId 风格）；提交载荷里也有 `call_…` 风格 |
| `tool.result.status` | `status:` → `Success` / `Failed` / `Running` |
| `tool.result.duration_ms` | `cost: <N>ms`；RunCommand 优先取 `state.json` 的 `finished_at - started_at` |
| span status | `Failed` → `ERROR`；`Success` → `OK`；`Running` 见 §6.1 |
| `trae.command.id` | `RunCommand` 专有，实测 `job-e171343b3f804a…` |
| `gen_ai.tool.call.arguments` | ⚠️ 非 RunCommand **仅失败时可得**（§2.5）；RunCommand 可从 `state.json.command` 完整获取；hook 的 `PreToolUse` 可全量补齐（仅限官方标准化工具名清单内的工具，见 §2.7） |
| `gen_ai.tool.call.result` | ✅ RunCommand 取 `output.log`；其他工具取提交载荷的 `toolcall_resp`（§2.5.1），按工具名 + 提交时刻配对 |
| `trae.command.exit_code` | RunCommand 专有，取 `state.json.exit_code` |
| `workspace.path` | RunCommand 可取 `cwd.txt` / `state.json.cwd` |

> TOOL span 的起点靠 `end - cost` 反推，极少数情况会越过迭代边界（早于本 STEP 的 LLM 开始）。
> 此时夹到迭代起点并标 `trae.start_clamped=true`（`tool.result.duration_ms` 仍保留真实 cost）；
> 若是 toolhost 给的真实起点，则反过来放宽 LLM 起点并标 `trae.llm.start_adjusted=true` —— 真实时间优先。

> **TOOL span 分两类处理**：`RunCommand` 额外拥有 `exit_code` 与真实起止（toolhost 落盘）；其余工具靠 `toolcall_resp` 拿结果、靠 `end - cost` 反推起点。真正的缺口只剩**非失败工具的参数**（需 `PreToolUse` hook）。

## 5. 时间边界规则

日志**只给出 `cost` 与检查点时间戳，不直接给 span 的 start/end 对**，因此：

| span | start | end |
|------|-------|-----|
| ENTRY | `rs_01_chat_begin` 的 epoch ms | `finish` 工具完成时间；缺失时取该 trace_id 最后一条日志行时间 |
| AGENT | `rs_06_resolvers_begin` / `rs_09_process_task` / 首个 STEP 三者最小（准备阶段的 span event 必须落在窗口内）| 同 ENTRY |
| STEP（迭代 i）| 本迭代 LLM 的 start | 本迭代最后一个工具结束；无工具时等于 LLM 的 end |
| LLM（迭代 1）| `rs_16_llm_generate_plain_item` | 本迭代首个 TOOL 的 start；无 TOOL 时取轮次结束 |
| LLM（迭代 i>1）| 上一迭代的 `commit_toolcall_result` 时刻 | 同上 |
| TOOL | `日志行时间 − cost` **反推**（RunCommand 优先用 `state.json.started_at`）| `ToolcallService … finished` 的日志行时间戳 |

> 两个必须守住的不变式（validator 会报 error）：**迭代之间不重叠**（天然成立：迭代 i 起于 commit i-1、止于 commit i），
> 以及**STEP 内 LLM 不晚于所有 TOOL 开始**（估算起点越界时的处理见 §4.3 末尾）。
>
> TOOL 的 start 靠 `end − cost` 反推是本方案唯一的时间近似点。误差来源于日志写入与工具真实结束之间的间隔，实测为亚毫秒量级，可接受。

## 6. 边界情况

### 6.1 `status: Running` 的工具
【实测】`RunCommand` 大量以 `status: Running` 结束（cost 861–1291ms）——这是**异步下发到 toolhost 终端后即返回**，不代表命令已完成。
→ 方案：`Running` **不置 ERROR**，而是通过 §2.6 的三级关联链路补齐真实结果 —— 用 `command_id` 定位 `jobs/job-<id>/state.json`，取 `exit_code`（定成败）与 `finished_at`（定结束时间）。关联不到时才保留 `Running`。

> 注意：`jobs/` 位于 `/var/folders/…/T/`（系统临时目录），**会被 macOS 定期清理，也不跨重启保留**。采集必须追平实时进行，不能依赖事后回扫。

### 6.2 检查点乱序
【实测】`rs_05_create_snapshot` 出现在 `rs_18` 之后（编号 05 却最后触发）。
→ 方案：**一律按 epoch ms 排序，禁止依赖 `rs_NN` 编号推导先后**。

### 6.3 未完成 / 中止的轮次
无 `finish` 工具、无 `rs_18` 的 trace_id 视为未完成轮次。
→ 方案：参照本项目 Codex 的中止轮次恢复思路（见 [codex-aborted-turn-recovery](../codex-aborted-turn-recovery.md)），以最后一条同 trace_id 日志行时间收尾并置 span status 为 ERROR / `error.type=aborted`。

### 6.4 日志轮转
TRAE **每次启动新建目录**：`logs/20260817T153641/`、`logs/20260817T153924/`，文件名含 epoch ms（`ai-agent_0_1786952364361_stdout.log`）。样本单文件已达 **242 MB**。
→ 方案：采集器需发现最新目录、处理跨目录轮转，并按 (inode, offset) 持久化位点；不可假设单一固定路径。

### 6.5 高噪声模块
【实测】`ai_agent::domain::model::model_mgr` 单模块占 119,218 / 131,828 行（**90%**），内容为 `keep_syncing_model_info` 心跳类刷屏。
→ 方案：解析前先按模块名白名单过滤，只保留 `timing` / `toolcall` / `chat` / `plan` / `handler` 等相关模块，否则 CPU 全耗在无用行上。

## 7. 脱敏要求（接入前必须落地）

【实测】日志中存在**明文凭证与敏感内容**，直接采集会把密钥送进 SLS / HTTP 下游：

| 风险点 | 位置 | 处置 |
|--------|------|------|
| **模型 API 密钥明文** | `ai_agent::handler::chat` 打印完整 `CustomModel{…}`，含 `ak: Some("QeSxmJ8On…")`（dashscope 凭证） | 必须在 `src/mask/` 增加规则，整体丢弃 `ak` / `sk` / `session_token` 字段 |
| **命令原文** | `[RUN_CMD_S] <命令全文>`；另 `state.json.command` 与 `toolhost.log` 的 `command=` 也含全文 | 按现有脱敏策略处理；`captureMessageContent=false` 时不得进 span |
| **命令输出全文**（新增） | `jobs/job-<id>/output.log` 是任意命令的原始 stdout，**可能含任意敏感物**（token、密码、内部数据）。实测样本中已含 `machineId` / `deviceId` / `userId` | 默认**不采集全文**；如需采集必须过 PII 检测 + 长度截断，并受 `captureMessageContent` 控制 |
| 用户 prompt / 上下文 | `resolver.user_message` 相关 | ❌ 实际本地无内容（§2.5），无需脱敏 |

另：`~/.trae-cn/trae-jwt-token` 为凭证文件，采集范围**必须排除**。

## 8. 待确认清单

1. `token_count=Some(N)` 的语义归属（input / output / total）——决定 `gen_ai.usage.*` 能否填。
2. `turn_id` 是否稳定输出（样本仅 9 次），若不稳定则 turn 唯一键退化为 `trace_id`。
3. 多 session 并发时 `trace_id` 是否仍严格 1:1 对应轮次（样本为单 session 串行）。
4. `conversation_id`（26 次）与 `session_id`（13530 次）的关系，是否存在会话分叉。
5. 非 `solo_agent` 模式（Chat / Builder / InlineChat 等，实测 `default_functions` 列出十余种）的 span 路径是否一致——本文瀑布仅取自 `solo_agent`。
6. 自定义模型（实测为 `aliyuncs//qwen3.7-max`，`use_remote_service: true`）与 TRAE 内置模型的 span 路径是否一致——若内置模型走不同链路，`svr_*` 字段可能缺失或变形。
7. 非终端工具是否在其他位置有明文落盘（当前结论为无，但未穷尽 `ModularData/ai-agent/snapshot/` 与 `sandbox/restricted/`）。
8. `Notification` 的 `idle_prompt` 是否**每轮必发且只发一次**——§2.9 拿它做轮次终止信号。已观测到 3/3 轮正常发送（含一轮无工具的纯问答），但样本太小；若会漏发，轮次状态只能靠 12h TTL 与下一次 `UserPromptSubmit` 回收。
9. `SessionStart.source` 是否仍只有 `startup`（官方写「目前仅支持」，实测也只拿到 `startup`）——如后续新增 `resume` 类取值，会影响会话连续性判定。
10. ⚠️ **「导入 CLAUDE 中的 Hooks 配置」开关的实际行为**：开启后 TRAE 会读 `~/.claude/settings.json` 并合并执行，而本项目的 claude-code hook 就在那里。需验证：此时 pilot 的 claude-code 处理器是否真的被 TRAE 拉起、payload 长什么样（能否用 `TRAE_PROJECT_DIR` / `workspace_roots` 等 TRAE 特有字段识别宿主）、开关状态能否从本地配置读到。不处理会直接造成**重复计数 + Agent 归属错位**。

### 8.1 本轮真机验证已结掉的项

以下条目已在真机跑通一轮完整会话（session `6a831b63c98f05bce2b2febd`，trace `37221bfbf11e0306c939bc731e40241c`）后得出结论，不再是风险项：

| 原待确认项 | 实测结论 |
|---|---|
| 沙箱下能不能写 `~/.loongsuite-pilot/` | **不造成阻塞**。日志自证 `[Hooks] configured_exec_env=host, effective_exec_env=host`，hook 默认就跑在宿主侧，13 条记录正常落盘、`errors/` 目录未生成。注意这与 RunCommand 自己的沙箱是两回事（同一轮里 RunCommand 是 `exec_env=Some("sandbox")` / `now_run_mode in_sandbox`）。 |
| `finish` 是否触发 hook | **不触发**。同一轮里 `[ToolcallService] Run tool finish` 有记录，但 PreToolUse / PostToolUse 一条都没有，且它的 `[execute_toolcall] toolcall_id=` 为空。它是 TRAE 内部终止工具，无结果属于预期。 |
| `TodoWrite` 是否触发 hook | **触发**，参数与结果均完整（已在前一轮样本里拿到 434 / 1487 字节）。`SearchCodebase` 本轮未触发到，仍未验。 |
| hook 能不能推出 ReAct 迭代边界 | **不能**，且原先设计的启发式已被推翻。详见 §8.2。 |
| 配置变更要不要重启窗口 | **不用**。每次 chat 请求都会重新 `resolve_hooks_config`（日志里每轮都有一条 `is_ok=true`），写完 `hooks.json` 下一轮即生效。 |

### 8.2 【已推翻】不能用 hook 事件流切 ReAct 迭代

曾设计过一个启发式：「`PreToolUse` 出现在 `PostToolUse` 之后，就说明结果已回给模型、又发生了一次推理」。**实测该启发式是错的**。

同一次 LLM 响应下发了 LS / Read / RunCommand 三个工具，日志侧的真相是：

```
22:33:40.435  [handle_stream] ToolCall arrived: LS          ┐
22:33:41.068  [handle_stream] ToolCall arrived: Read        │ 同一个流吐出的 3 个 tool call
22:33:41.787  [handle_stream] ToolCall arrived: RunCommand  ┘
22:33:44.822  [commit_toolcall_result] endpoint=            ← 迭代 1 到这里才结束
22:33:57.968  Run tool `finish`                             ← 迭代 2
```

但 TRAE **边流式接收 tool call 边执行**，所以 hook 侧看到的到达顺序是
`Pre(LS) → Post(LS) → Pre(Read) → Pre(RunCommand) → Post(Read) → Post(RunCommand)`。
启发式会把这一批拆成两批（LS 归第 1 批，Read + RunCommand 归第 2 批），与真实结构不符。

因此：

- **ReAct 迭代边界只能从日志的 `[commit_toolcall_result] endpoint=` 取**，hook 无权参与分步。
- hook 只输出诚实可得的 `agent.trae.tool_seq`（本轮内第几个工具调用，Pre / Post 靠 `tool_use_id` 共享同号），原先的 `agent.trae.tool_batch` 已删。
- 纯 hook 链路上仍维持「一轮 = 一个 step」：hook 每轮只给得出一个 `llm.request` + 一个 `llm.response`，拆成多 step 会产生没有 LLM 的 STEP，直接违反 `structure.step_has_one_llm`。

### 8.3 【已修正】两个已踩中的字段误判

| 问题 | 现象 | 修正 |
|---|---|---|
| 工具状态全文嗅探 | 把整个 `tool_response` 拿去正则匹配 `\berror\b`，导致「读一个正文里写过 error 的文档」被判成工具失败 | 只认结构化信号（优先级：结果体内 `exit_code` › `is_error` › `success` › `error` 字段 › 内容键存在），字符串结果只看开头是否错误抬头；判定依据写入 `agent.trae.status_source` |
| `exit_code` 嵌层没取到 | `exit_code` 在 `tool_response` 内而不在顶层，失败的 RunCommand 因为带了 `stdout` 字段而被当成成功 | 先查结果体内的 `exit_code` / `exitCode`，对齐 `inferToolStatus` 基线 |
| provider 按客户端硬编码 | 曾把 `agent.type` 含 `trae` 一律归为 `bytedance.doubao` | 实测本机 TRAE CN 跑的是 `aliyuncs//qwen3.7-max`，TRAE 是多模型宿主。已去掉该推断，拿不到模型名就给 `unknown` |

### 8.4 【新发现】工具精确关联的 join key

日志的 `[execute_toolcall] toolcall_id=call_xxx, name=YYY` 与 hook 的 `tool_use_id` 是**同一个值**，
可以把两侧工具信息精确对上，不用「工具名 + 时间窗」模糊匹配（后者在同一轮里反复调用同名工具时会串位）。
注意这与 TRAE 内部的 24 位 hex toolcall id（如 `6a831bc6c98f05bce2b2fed3`）不是同一个体系。

还有两个可用的精确关联点：

- RunCommand 的 `tool_response` 里带 `command_id: job-xxx`，直接指向 toolhost 的 job 落盘目录。
- `[Hooks] ToolingHookCommandRunner executing command="… <EventName>"` 这行同时带 TRAE 的真 trace_id 与 session_id，可以把 hook 记录绑到真 trace（hook 自己的 payload 里没有任何 trace id）。

### 8.5 【已推翻】迭代数不能靠「尾窗口」启发式猜

曾用「最后一次 commit 之后还剩 ≥800ms，就算发生了一次收尾推理」来补最后一个 STEP。
**这会凭空造出一个不存在的 LLM span**。

实测那一轮全程只有**两次**服务端请求：

```
22:33:36.697  POST /api/agent/v3/create_agent_task        body 32152B   ← LLM 调用 1
22:33:44.822  POST /api/agent/v3/commit_toolcall_result   body  5548B   ← LLM 调用 2
```

`finish` 之后那 1.22s 里日志只有 `filter_files_outside_workspace`、
`[run_finish][products_accumulation]`、snapshot diff、Stop hook、`chat_turn_finish`，
**没有第三个 HTTP 请求**——那是收尾处理，不是推理。

正确规则：

> **本轮 LLM 调用次数 = `create_agent_task` 次数（1）+ `commit_toolcall_result` 次数**
> （每个 commit 的**响应**就是下一次流）。

这也顺便给出了每个 LLM span 的**真实起点**，不再用上一次 commit 时刻推断；
起点是否实测记在 `trae.llm.start_observed`。
注意面向用户的最终回答属于**最后一次真实推理**（它同一个流里既吐了 `finish` 工具调用，也吐了回答正文）。

### 8.6 【已修正】工具起点不该用 state.json 的秒级时间

`[ToolcallService] Start run tool` 给的是**毫秒级**真实起点，
而 toolhost `state.json` 的 `started_at` 是**秒级**的。实测后者把 RunCommand 起点
提前了 354ms（`43.354` → `43.000`），不仅不准，还把中间的审批相位
（`[FileOp][confirm]` / `[need_manual_confirm] … will auto run`）盖掉了。

改用 `Start run tool` 后，**全部工具 span 的起点都是实测值**（`trae.start_estimated=false`），
方案里原先「唯一的时间近似点」消失；且 RunCommand 耗时从 1.24s 修正为 886ms，
与日志 `Run tool RunCommand finished, cost: 886ms` 完全吻合。

### 8.7 轨迹完整度：壁钟覆盖率与空白窗口

结构校验（span 层级自洽）与**完整度**（有没有漏掉过程）是两件事，必须分开验。
`demo/trae-trace-demo/src/audit-coverage.mjs` 做后者：把轮次时长里不被叶子 span
（LLM / TOOL）覆盖的区间逐段列出来，并检查每段是否有 span event 交代。

实测本轮：**叶子 span 覆盖 80.8%**，剩下 4.54s 分 5 段空白，全部已由 span event 交代：

| 空白窗口 | 时长 | 实际在做什么 |
|---|---|---|
| 轮次开头 | 1.19s | 预处理：`turn.begin` → 取会话 / 取历史 / 建消息 / 取模型 / 5 个 context resolver / 建任务 / 建轮次 / 渲染 prompt |
| 工具之间 | 858ms | 等后续 tool call 流式到达（`toolcall.streamed:RunCommand`）|
| 工具之间 | 695ms | RunCommand 审批流（`tool.confirm.begin` → `tool.confirm.auto_run`）|
| 工具之后 | 582ms | 结果持久化 + 提交准备（`result.submit`）|
| 轮次结尾 | 1.22s | 收尾：`turn.finish.begin` → 文件/skill 过滤 → products_accumulation → snapshot diff → Stop hook → `chat_turn_finish` |

准备阶段与收尾阶段不能建成 STEP（STEP 必须恰好含 1 个 LLM，而这些阶段无推理），
所以统一挂为 AGENT 上的 span event。

### 8.8 timing 埋点只覆盖本轮首次 LLM 调用

【实测】一轮只在结束时吐**一批** `[Timing] events for trace_id`，其中
20 个 `rs_*` 与 23 个 `svr_*` 各只有一组值，时间跨度仅 `+0 ~ +3250ms`（轮次总长 23.7s）。
也就是说：

- `rs_18_llm_response_first_token`（TTFT）**只有首次调用有**，迭代 2+ 的 TTFT 拿不到。
- `svr_*` 服务端耗时拆解（网关 / 预处理 / 首包 / 后处理）**也只对应首次调用**，
  挂在轮次层面时不能当成全轮均值。

早前注释里写的「单轮 rs_16 出现 7 次」是其他会话的观测，不是普适规律；
代码仍保留按窗口匹配 `rs_18` 的逻辑（而不是 `find()` 第一条），以兼容多批情形。

### 8.9 【严重】日志会把工具结果原样回灌，正则必须锚定消息体开头

【实测踩中】`[commit_toolcall_result]` 那一行的 payload 里**内嵌了工具结果全文**。
如果 Agent 读过一份讲 TRAE 日志的文档，文档里引用的日志样例就会随结果一起进入日志行，
被无锚点的正则当成 TRAE 自己的日志：

```
被读文件 轨迹追踪.MD 第 46 行：
  Run tool SearchCodebase finished, status: Success, cost: 724ms
        ↓ 随 Read 结果进入 commit payload，再被打进日志
无锚点正则 /Run tool (\S+) .* cost: (\d+)ms/ 匹配成功
        ↓
轨迹里凭空出现一次 724ms 的 SearchCodebase 调用
```

这类污染是**自指的**：越是拿本方案文档去测，越容易造出假 span。

**规避方式**：TRAE 自己的日志消息一律以 `[Module] ` 起头，而回灌内容只会出现在消息体中段。
所以先用行首规则切出消息体，再用 `^` 锚定的规则去匹配：

```js
const msg = head ? line.slice(head[0].length).trimStart() : line;
RE.tool = /^\[ToolcallService\] Run tool (\S+) .../;   // 锚定 + 只对 msg 匹配
```

`trace_id` 同理，要取行内**最后一个**匹配（tracing 字段追加在行尾，回灌内容在中间），
否则整行会被归到伪造的 trace 上。

此坑与 8.3 的 `normalizeStatus` 全文嗅探是同一类：**别拿正文当信号**。

### 8.10 【严重】采集器自身开销占整轮 17%~30%，且必须在轨迹里披露

【实测】TRAE 是**同步阻塞**等 hook 进程返回的（`ToolingHookCommandRunner executing` →
`finished` 之间没有其他工作）。实测数据：

| 会话形态 | hook 次数 | 阻塞总耗时 | 占整轮壁钟 |
|---|---|---|---|
| 8 工具 / 3 迭代 / 37.7s | 17 | 11.37s | **30%** |
| 10 工具 / 7 迭代 / 69.7s | 21 | 11.86s | **17%** |

单次 hook 端到端 **533~541ms**，拆解如下（这台机器 `node` 冷启动约 290ms）：

| 阶段 | 耗时 | 是否必要 |
|---|---|---|
| `pilot_node_is_suitable` 里的 `node --version` | ~290ms | **冗余**——pin 文件在安装时已校验 |
| 跑 `trae-cn-hook-processor.mjs` | ~300ms | 必要 |

即**约 55% 的 hook 延迟花在一次多余的 `node --version` 上**：`resolve_pilot_node_bin`
读到 `~/.loongsuite-pilot/node-bin` 的 pin 之后，仍会 spawn 一次 node 验版本。
pin 机制省掉了目录扫描，但没省掉进程启动。

> `shared/node-runtime.sh` 是**所有 Agent 共用**的解析器，改它会影响全部接入方，
> 因此这里只记录测量结果，不在本方案内单方面改动。

两个直接后果：

1. **观测代价必须诚实披露**。不记录的话，这些时间在轨迹上表现为工具之间
   「无交代的空白」——等于把观测者自身的成本藏进了被观测系统的耗时里。
   现已挂到 AGENT span：`pilot.hook.count` / `pilot.hook.total_ms` /
   `pilot.hook.overhead_pct`，并为每次 hook 生成带 `pilot.hook.duration_ms`
   的 `pilot.hook:<Event>` 事件。
2. **空白窗口的判定要区分点与区间**。hook 开销是真实占用壁钟的**区间**，
   只要与空白重叠就算已交代；相位标记是**时刻**，需落在窗口内才算。

### 8.11 验证要分三层，且交叉校验不能复用主解析器

单靠「span 层级合法」不能说明轨迹可信。现有三个工具各管一层：

| 工具 | 回答的问题 | 判据 |
|---|---|---|
| `check-structure.mjs` | span 层级合法吗 | 对齐 `scripts/validate-trace.mjs` 的 10 条规则 |
| `audit-coverage.mjs` | 有没有漏掉过程 | 壁钟覆盖率 + 每段空白是否有交代 |
| `cross-validate.mjs` | 内容有没有搬错/串位 | 与原始日志、hook JSONL 逐项比对 |

`cross-validate.mjs` 的 11 项检查里，最关键的是
**「span 上的参数/结果是否来自同一个 `tool_call_id` 的 hook 记录」**——
这是唯一能抓出串位的检查。实测在「同一批 5 次 Read」的会话上仍 5/5 正确。

> ⚠️ 交叉校验**必须独立重新解析**原始数据。复用 `parse-agent-log.mjs` 等于自证，
> 解析器错了两边会一起错。但「独立」不等于「可以写得随意」：第一版正是因为
> 图省事没锚定消息体开头，踩了 8.9 的坑，反过来误判正确的 build-trace 漏了工具。

另有两个失效模式是后来才暴露的，一并记下：

- **“真值全 0”会以一致的形式静默通过**。抽真值时读错了日志文件，每一道
  「构建 0 vs 日志 0」都会变绿，等于什么也没校。现已加一道
  `ground_truth_non_empty` 打头阵。
- **trace 归属也会中 8.9 的招**。校验器用 `line.includes(traceId)` 筛行，
  结果把「引用了本 trace_id 的别的轮次日志」也算进来，6 次 commit 数成 14 次。
  必须取**行内最后一个** `trace_id`，与主解析器同一条规则。

### 8.12 并发工具不能用时间窗归属子事件

一次推理会**并发下发多个同名工具**，它们的区间两两重叠。实测一轮里 4 次 WebSearch：

```
#1  +0ms    ~ +890ms
#2  +447ms  ~ +2512ms     ← 与 #1 重叠
#3  +8605ms ~ +10454ms
#4  +9090ms ~ +11845ms     ← 与 #3 重叠
```

早前用「工具区间 ±200ms 内的抓取都算我的」归属逐页抓取，结果 #4 把 #3 的 5 页
也吐了进去，报成 10 页、token 数 26513（= 11350 + 15163，正好是两次的和）。

正确做法是抽出日志里真存在的归属链，按 **URL 对号**：

| 信号 | 作用 |
|---|---|
| `[WebSearchDomainFilter] stage=tool_entry query="…"` | 本次搜索的**查询词**（= LLM 下发的工具参数） |
| `step1 request_search_references completed: … references_count=N` | 原始命中数 |
| `step2 crawler targets: count=N, urls=[…]` | 本次的**抓取目标清单**（开括号，完整不截断） |
| `fetch_single completed: url=U, …` | 单页抓取，按 U ∈ 清单归属 |
| `all steps completed: total_elapsed=T (step1=…, step2=…)` | 闭括号；T 与工具 `cost` 同值（误差 0~2ms） |

工具 span 与搜索记录拿「cost 相符 + 收尾时刻最近」做唯一匹配并从池里领走（容差 50ms，
远小于并发搜索的最小间隔 447ms）。修后 5 次 WebSearch 各归各位，无一例串位。

> 这个教训不限于 WebSearch：只要同类子事件会并发，时间窗归属就不可靠，
> 必须找日志里真存在的 id / 清单 / 括号结构。

另外，**抓 0 页有两种截然不同的原因**，得分开说，否则会被当成采集漏洞去查：
`references_count=0`（搜索本身无命中）与「有命中但抓取目标为 0」（域名过滤筛光了）。
实测 #1 属于前者，日志有明确交代（`crawler targets: count=0, urls=[]`）。

### 8.13 等用户确认的时间必须从 Agent 耗时里拆出来

轨迹里曾有一段 **18 秒**无任何交代的空白。反查日志发现那里什么也没发生 ——
**命令被沙箱拦下，TRAE 弹了确认框，在等用户点击**。

区间信号是一对干净的括号（实测 8 开 8 合，靠 `confirmation_id` 配对）：

```
[PendingInteractionRegistry] register confirmation_id=<CID>, plan_item_id=Some(…),
    toolcall_id=Some(…), extra_route_ids=["call_xxx"], session_id=Some(…)   ← 开
[PendingInteractionRegistry] route user decision, confirmation_id=<CID>, …        ← 合
[need_manual_confirm] toolcall_id is: …, manual_confirm_reason is: <原因>,        ← 原因
```

两个必要的实现细节：

1. **这两行不带 `trace_id`**（跑在 `process_ipc_request:route` 而非 chat 跨度上），
   所以不能按 turn 收集，只能全局收集后靠 `extra_route_ids` 里的 `call_xxx` 对到工具。
2. 等待区间在工具真正开跑**之前**，不在工具 span 区间内，因此挂到 AGENT 上作为
   带区间的 `user.confirm.wait` 事件，只在工具 span 上留属性标注。

实测到三种拦截原因与很大的等待量：

| reason | 触发工具 | 实测等待 |
|---|---|---|
| `sandbox_execute_failure` | RunCommand | 18.0s / 12.2s |
| `file_outside_workspace` | Write | 54.6s / 50.8s |
| `in_red_list` | Shell | 10.2s / 37.6s / 149.1s / **582.3s** |

> 不拆这一项，一个 9.7 分钟的等人时间会直接计到 Agent 头上。它与采集器 hook 开销（§8.10）
> 同属「不属于 Agent 本身的壁钟」，所以 `audit-coverage.mjs` 把两者统一归为**区间事件**
> （与空白重叠即算交代），区别于只能证明某一瞬间的**点事件**。

剩下的 90~550ms 缝隙同样有名字：工具 A 跑完了但本次推理的流式响应还没收完
（TRAE 边流式接收边执行），流收尾后才派发工具 B。用
`plan final token cost: Xms` 与 `[FileOp][dispatch] tool=X` 两个相位标记即可交代。
加上这两条后，旧日志 11 轮（含 32 × RunCommand 和 87 工具的超长轮次）的空白全部有交代。

### 8.14 LLM 调用的真实可得边界（以及能重建到什么程度）

「LLM 调用不可见」这件事要分开看：**请求参数本地可得，真实 messages 本地不可得**。

已查证的不可得路径（不是没找到，是确实不存在）：

| 设想的来源 | 实测结论 |
|---|---|
| `create_agent_task` 日志行 | 只有 308 字符，**无 payload body** |
| `commit_toolcall_result` payload | 只有 `toolcall_results[]` + `extra_context.todo_list`，**无 messages** |
| `handle_stream` | 只记 ToolCall 到达，不含助手文本 |
| hook payload | 不给 `transcript_path`；只有 Stop 的 `last_assistant_message` |
| `ModularData/ai-agent/hooks_env/*.env` | **0 字节空文件** |
| `state.vscdb` | 81KB，纯 UI 状态；消息在 11MB 的 SQLCipher `database.db` 里 |

根因是 prompt 由**服务端**拼装（`svr__02_preprocess_build_llm_prompt`），客户端从头到尾
没有完整请求体。

**本地确实可得的请求参数**（来自 `[ModelConfig] Received …`）：

```
gen_ai.request.max_tokens          64000
trae.request.prompt_max_tokens     936000
trae.request.max_turn              500
trae.request.native_function_call  true      ← 工具调用走原生 function call
trae.request.pass_back_reasoning   true      ← 思考过程回传给下一轮
```

**messages 采用重建 + 三标注**，不冒充真实请求体：

- 输出 = 该次推理下发的工具调用（`tool_call` parts，带 `call_xxx` 与参数）
- 输入 = 首轮的用户 prompt；第 2 轮起为上一轮的工具结果（`tool_call_response`）
- 每个字段附 `trae.{input,output}.provenance` / `.complete` / `.missing`

> 重建**必须在全部 STEP 建完之后**回填。工具的参数/结果是在建 TOOL span 时才从
> hook、commit 载荷、toolhost 产物三个源合并出来的，只有读建好的 TOOL span 才能保证
> messages 与页面展示的内容一致，否则两边会分叉。

前端也据此区分展示：ENTRY 上的 `gen_ai.input.messages` 打 `hook` 徽章（原文可信），
LLM 上的标题写「LLM 输入 messages（重建）」并显示 provenance 与「不含：…」。

**usage 本地拿不到**，且早前有个误判必须纠正：日志里的 `token_count` 来自
`[RemoteFetchStrategy] fetch_single completed`，是**联网抓取的网页内容**的 token 数，
与 LLM 用量毫无关系。现已在 span 上写死 `trae.usage.availability` 说明原因，
避免下游当成采集遗漏去查。

### 8.15 多 Agent 模式：能力声明可读，子智能体禁止建成嵌套 AGENT

TRAE 的智能体模式（Agent 可调用 Search 子智能体，内置阅读/编辑/终端/预览/联网搜索）
在本地有**明文**声明，位于渲染端 `state.vscdb`（与 ai-agent 的 SQLCipher `database.db`
是两回事）：

| 键 | 内容 |
|---|---|
| `currentAgentData_<userId>` | Agent 完整声明：`built_in_tool_list` / `members` / `can_be_sub_agent` / `is_merged_agent` |
| `icube_session_agent_map` | session_id → agent_id |
| `<userId>_AI.agent.plan.mode.map` | session_id → 是否规划模式 |

实测 `built_in_tool_list: [readonly, edit, terminal, preview, web_search]`
→ 阅读/编辑/终端/预览/联网搜索，`members: ["search"]`，与产品界面一字不差。

> ⚠️ 两条硬约束：**必须先拷贝再读**（直连活动库会触发 WAL checkpoint，等于写入用户的
> IDE 状态），且只读白名单里的键。

运行侧的谱系来自 `[do_create_cloud_agent_task] agent_run_info: subagent_type=…,
agent_call_id=…, parent_agent_run_id=…, agent_run_id=…`。

**子智能体不能建成嵌套 AGENT span**：仓库 `scripts/validate-trace.mjs` 的
`structure.single_agent` 要求一个 trace 恰好 1 个 AGENT，`agent_under_entry` 要求它的父是
ENTRY。沿用 Codex 子智能体融合的既有词汇表（见 `docs/codex-subagent-fusion.md` 与
`otlp-trace-flusher.ts` 的 `GEN_AI_HIERARCHY_PASSTHROUGH_KEYS`）：

```
gen_ai.agent.scope                  main | subagent
gen_ai.agent.depth                  0 | 1
gen_ai.agent.parent.id              父 agent_run_id
gen_ai.subagent.parent_tool_call.id 触发它的工具调用
```

主 Agent 场景额外写 `trae.subagent.observed=false` + `trae.subagent.evidence`，
把「本轮确实没委派」与「采集不到」区分开 —— 否则会被当成采集遗漏去查。

> **当前状态**：子智能体路径的代码已按上述 schema 写好，但**缺真实数据验证**。
> 跨全部日志统计，`subagent_type` / `agent_call_id` / `parent_agent_run_id`
> **命中数均为 0**，即历史上从未真正触发过子智能体委派。需要一轮真实调用 Search
> 子智能体的会话才能验证。

顺带修掉一个 id 语义错误：`run_command finish, toolcall_id: <24 位 hex>` 是 TRAE
**内部**的 toolcall id，与 LLM 下发的 `call_xxx` 不是同一个东西，早前被写进了
`gen_ai.tool.call.id`。现在 `gen_ai.tool.call.id` 统一取 `[execute_toolcall]` 的
`call_xxx`，内部 id 归到 `trae.command.toolcall_id`。

### 8.16 【严重】session 找不到时不能静默退回「全都要」

一台机器上可能同时开着**多个 TRAE 窗口**，每个窗口各自一份 `logs/<时间戳>/` 目录，
各写各的 session。而「最新活跃日志」未必包含你要的那个 session。

原实现在按 session 过滤后写了一句宽松兜底：

```js
result = bound.length > 0 ? bound : result;   // ← 找不到就全都要
```

后果是：请求 session A，日志里没有 A，于是**别的 session 的 12 轮轨迹被贴上 A 的标签
返回**，`ok: true`，页面正常渲染。这正是整个工作一直在防的那类凭空造假。

现在分三种情况：`exact`（命中）/ `unbound`（整份日志都没绑定任何 session，宽松纳入合理
但要标出来）/ `absent`（日志里有其他 session 但没这个 → 返回空并显式报错）。
遇到 `absent` 时再去其他窗口的日志里找。

> ⚠️ 「哪份日志包含这个 session」**不能只靠字面搜索**判定，它会中两种假阳：
> `recently used sessions: ["<id>", …]` 会把别的窗口的 session 列出来（实测 19 次命中、
> 0 次是真实 tracing 尾字段），payload 回灌也会带进 `session_id=`。
> 所以字面扫描只作**预筛**，权威判定必须是解析结果 `sessionMatch === 'exact'`。

## 9. 与本项目的衔接

- **采集基类**：走 `BaseSessionInput` 或 `BaseInput`（尾随文本日志 + 按 `trace_id` 聚合成轮次），**不是** `BaseSqliteInput`。
- **输出**：ENTRY/AGENT/STEP/LLM/TOOL 五类 span 经 `MultiFlusher` → `OtlpTraceFlusher` 导出，与既有 Agent 完全同构。
- **client type**：需新增 `trae-cn`。
- **声明文件**：`agents.d/trae-cn.json`，部署模式为 **Hook 注入（写 `~/.trae-cn/hooks.json` 或 `<工作区>/.trae/hooks.json`）+ 日志尾随双源**：
  日志提供迭代骨架与时序（开箱可用），hook 提供 prompt / 工具参数 / 最终回答（需注入）。
  两者缺一不可：只有日志则无内容，只有 hook 则退化为一轮 1 个 STEP、丢失迭代保真度（§3.2 末）。
