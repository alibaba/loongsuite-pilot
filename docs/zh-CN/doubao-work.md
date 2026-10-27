# 豆包工作客户端与本地执行观测（实验性）

`doubao-work` 被动读取 macOS / Windows 正式版客户端的日志及本次新会话的原生文件，不安装 Hook、不修改客户端或登录状态。已观察的协议基线为 macOS 2.33.10、Windows 2.25.18。客户端可见信息不覆盖云端的完整 Agent、ReAct 或模型调用；采集结果明确标记这些缺口。

## 数据与语义

| 原生证据 | 输出 |
|---|---|
| 精确关联的消息提交与结束日志 | 一对标准边界事件和 ENTRY → AGENT；表示客户端请求区间，保留源时间精度 |
| 本地 `toolcall` 的 `received` / `execution_settled` | 以调用 ID、sandbox、actor 严格配对的 `tool.call` / `tool.result` 日志；已确认所属请求或本地 TASK 内另附同时间的 Span events |
| `assignment.md` 中本次请求窗口内唯一需求 | 根 AGENT 的 `gen_ai.input.messages`；本地 TASK 的 `input.value` |
| `trajectory.jsonl` 的最终 assistant 回复 | 有本次需求及调用结果顺序证据时，根 AGENT 的 `gen_ai.output.messages` 或 TASK 的 `output.value` |
| trajectory 的精确调用 ID、参数及结果 | 工具日志及 `gen_ai.tool.call` / `gen_ai.tool.result` Span events 的工具内容与原生决策批次 ID |
| 持久化的完整原生 sandbox execution UUID 和起止 | 一次本地执行对应一个 TASK，使用 `run_task`，不解释为云端 Agent invocation |
| 请求选择的 Skill / 伙伴标识 | `selected_skills` / `selected_partners`，只表示本次选择上下文 |

不能取得可靠起止的工具保留为日志，不生成 TOOL Span。没有真实模型名与每次模型调用起止，故不生成 STEP / LLM；不以工具间隙、需求文件时间、面板加载或首输出时间推断 ReAct。一个原生 assistant 批次中的并行工具共享 `native_decision_id`，它表示源批次而非定时 STEP。

首次 `cot_first_token` 的原生 SSE duration 仅写入自定义 `client_time_to_first_cot_ms`，表示提交到首个推理输出接收的客户端区间，不作为 LLM 耗时或模型 TTFT。模型、Token、成本、finish reason 和云端内部 reasoning 均不补造。

客户端的 `session_success=1` 也可能对应额度通知。所有请求保留 `business_outcome=unknown`；正常接收的根 Span 为 UNSET，明确的客户端错误或取消为 ERROR。本地工具结算状态与本地 TASK 结束不代表业务成功。

## 本地 TASK 与异步关联

原生 `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json` 的 `execution` 给出 `startedAtMs`、`endedAtMs`、`queryMessageId`、`sandboxId`。开始是本地 sandbox 获取回调，结束是释放时文件捕获完成回调，包含本地管理开销。

必须同时匹配新请求的 conversation、local message ID、唯一主请求 sandbox actor，以及 trajectory 中成对 `create_agent` 的无歧义创建关系。一个 execution UUID 只导出一次 TASK；工具只归到时间范围内且 actor/sandbox 完全一致的 TASK，祖先不复制后代工具。

同 query、sandbox 下唯一覆盖子执行、且在根请求区间内的本地父执行构成 TASK → TASK。其余完全位于已观察请求区间内的本地 TASK，依据精确 query 归属挂到根 AGENT；`trace_parent_resolution` 区分本地父执行与所属请求。Span Link 另外保留原根关联，但树结构不依赖后端是否保存 Link。`native_creator_agent_id` 仅表示创建者身份，不充当云端逐次 invocation 父边。

执行区间超出已观察客户端请求时，继续保留标准日志中的本地执行边界、身份及已采集工具事实，不导出无法被现有请求树容纳的 TASK Span。不延长请求、不复制祖先，也不制造新的 ENTRY / AGENT。元数据晚到而实际区间仍在请求内时，可以正常补上同一棵树；这与真正超出请求的后台执行分别报告。

子记录先到时短暂等待父记录；已观察父 Write/Edit 成功时在既有关联状态上限内继续等待。没有完整或唯一父执行证据时保留原始身份和 `parent_resolution`，不制造中间 Span。客户端仅持久化有被跟踪文件变更的本地执行；纯 Read/Bash、纯云端或未落盘的子 Agent 不保证有 TASK。未归入 Span 的真实工具日志仍保留。

## 内容、边界与可靠性

只读取新日志已确认的 conversation，支持 `Default` 与账号切换后的 `Profile N`，最多检查 16 个 Profile；同一 conversation 在多个 Profile 出现时跳过歧义。轨迹与需求文件只在该会话内读取，不扫描历史、不读取 Cookie、登录缓存或消息数据库，也不读取快照中的文件正文。

本次需求必须在源请求窗口中唯一；复用会话的旧尾部、不同需求、未来需求或缺少当前调用结果时，不猜测输入输出。每个内容字段最多 64 KiB，超限省略。已取得本次需求而最终轨迹尚未落盘时，遥测管道最多等待 2 秒，随后有界降级；不阻塞客户端，也不改变 Span 源起止时间。Windows 本地回调名 `Bash` 可对应原生 `PowerShell`：两者分别保留，避免误报工具类型。新增内容均先走统一 InputManager 脱敏，再转换 Span events；不在脱敏后重新读取原文。

每个 Span 最多附 64 对工具事件，超出数量写入 `tool_observations_not_in_span`，完整已采集事实仍在 JSONL；缺失一端、身份冲突或非正时间的工具不导出完成事实。原生扫描每轮一个会话，最多 64 个 Agent、每文件 2 MiB、合计 8 MiB、祖先深度 8。快照另限 8 个账户、128 个执行/文件及 8 MiB，不跟随目录逃逸或符号链接。

增量日志支持半行、重启、轮转、截断与临时不可读。首次启用跳过历史；日志每次最多读 1 MiB、每轮 8 MiB、最新 128 个文件。请求与 sandbox 状态各最多 512 项/24 小时，工具状态最多 4096 项/24 小时，完成去重最多 4096 项/7 天。原生扫描至少间隔 10 秒，日志唤醒每秒合并一次。超限不承诺完整覆盖或端到端 exactly-once。

## 配置与验收

| 平台 | 源日志 |
|---|---|
| macOS | `~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log` |
| Windows | `%LOCALAPPDATA%/DoubaoWork/User Data/sdk_storage/log/saman_YYYY.MMDD.N.log` |

Windows 缺少 `LOCALAPPDATA` 时使用 `~/AppData/Local`；macOS 时间保留微秒，Windows 保留毫秒。`listeners.doubao-work.logDir` 可指定其他只读源目录；输出 `dataDir` 独立。

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

Agent 使用 `detection-only`。关闭 listener / Agent 即停止采集。Skill 的选中不证明实际加载；独立工作伙伴页面、云端完整 Agent 生命周期仍无覆盖。

真实验收分别核对源日志、标准 JSONL、OTLP 和 CMS 回读，确认 I/O 不串请求、工具 ID/时间/归属、TASK 唯一性与异步 Link。通用 Trace validator 保持 ENTRY → AGENT、AGENT → STEP、STEP → LLM / TOOL 的严格规则，不包含豆包例外。通过已输出数据的结构校验不代表完整 ReAct 覆盖，缺失层级必须单独报告。

本地观测日志用 `local_execution_phase` 表示资源起止，以 `root_turn_id` 保留关联；不写客户端 `gen_ai.turn.start/end`，也不创建新的客户端 turn。

## Mac 消息流验证

2026-10-27 在正式版 macOS 2.34.1 / Chromium 147 上进行了被动 CDP 验证。纯文本、顺序 Write → Read → Write → Read、组织者创建两个子 Agent 三个任务均有真实结果；子 Agent 两份新文件的内容已核对。连续四个工具调用只对应一个回复 ID，消息流的结束边界覆盖整个同步回复，不能据此拆出逐次 LLM 调用。

主页面与 launcher 各出现一次 `/chat/completion` 请求，但具有相同 local message ID 和回复 ID，必须识别为同一消息的两条物理传输。`STREAM_MSG_NOTIFY`、`STREAM_CHUNK` / `CHUNK_DELTA`、`SSE_REPLY_END` 提供消息和界面块的身份、内容与终止事实；工具界面块的 `is_finish` 不是模型调用的完成事件。模型字段 `38` 是内部枚举，`context_window_usage` 是上下文占用，两者均不转换为真实模型名或本次计费 Token。

多 Agent 会在同步回复后使用 `/chat/async/chunk_stream`。本轮已确认后台执行和原生创建关系，但未完成异步流及全部子 Agent 界面验收；不能把同步结束作为后台完成，也不能声称有完整多 Agent 网络覆盖。当前结论只针对已观察的路径，不排除客户端其他接口能提供更多信息。

Claude Code 的 fetch intercept 在真实 `/v1/messages` 请求上补充每次 HTTP attempt、SSE response ID 与起止，另有 transcript 的时间、模型和 usage。豆包页面则将消息请求交给缓存的自定义 fetch，再通过 `fetch-stream-for-im` 原生 MessagePort 发送。只包装全局 `window.fetch` 可能漏采；包装同一个收发入口也不会自动得到云端内部的逐次模型请求。

仓库保留一个开发诊断命令，要求 Node.js 22+ 和已经启用的本机回环 CDP：

```bash
node scripts/diagnostics/doubao-work-network-probe.mjs \
  http://127.0.0.1:9236 DBW_UNIQUE_TEST_20261027 /tmp/doubao-new-capture 120
```

等待 `Ready` 后，在新任务正文加入相同的唯一测试标识。输出目录必须不存在。脚本只启用 Network 观察和 [CDP 响应流读取](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent)，不暂停、重放或修改业务请求；只保存本次标识匹配的消息文本及白名单协议字段，不保存 headers、Cookie、签名 URL 或账号元数据。最多运行 300 秒、连接 16 个本产品页面、保存 4 MiB，每条流最多 1 MiB；超限或不支持流读取时明确记录缺口。

`network.jsonl` 是诊断事实，不是标准 GenAI 事件或可直接上报的 Span。重复物理传输保留，使用消息身份对照；不按请求数、工具块数或 `SSE_REPLY_END` 数量统计 LLM。只有观察到 `FETCH_STREAM.fetch_key` 才跟随对应 async task；尚未证明的线程/任务映射不会猜测关联。未知协议仅记录事件名，异步 snapshot 正文尚未适配。该脚本不接入常驻 collector、不自动开启调试端口、不上报 CMS；正式采集仍使用上文的被动文件 Input。
