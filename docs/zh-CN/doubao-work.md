# 豆包工作客户端与本地执行观测（实验性）

`doubao-work` 被动读取 macOS / Windows 正式版客户端的日志及本次新会话的原生文件，不安装 Hook、不修改客户端或登录状态。已观察的协议基线为 macOS 2.33.10 / 2.34.1、Windows 2.25.18。根据可见 assistant 消息重建标准 STEP / LLM / TOOL 链路，优先展示输入输出；模型、Token 和完整云端生命周期仍可能缺失。

## 数据与语义

| 原生证据 | 输出 |
|---|---|
| 精确关联的消息提交与结束日志 | 一对标准边界事件和 ENTRY → AGENT；表示客户端请求区间，保留源时间精度 |
| 本地 `toolcall` 的 `received` / `execution_settled` | 以调用 ID、sandbox、actor 严格配对的 `tool.call` / `tool.result` 日志；有可靠起止且完整位于已确认请求或本地 TASK 内时，导出独立 `execute_tool` TOOL Span |
| `assignment.md` 中本次请求窗口内唯一需求 | 根 AGENT 的 `gen_ai.input.messages`；本地 TASK 的 `input.value` |
| `trajectory.jsonl` 的最终 assistant 回复 | 有本次需求及调用结果顺序证据时，根 AGENT 的 `gen_ai.output.messages` 或 TASK 的 `output.value` |
| trajectory 的精确调用 ID、参数及结果 | 工具日志及 TOOL Span 的参数、结果与原生决策批次 ID |
| 当前请求的 assistant 消息顺序与可见历史 | 每个可见 assistant 决策对应一个 STEP 和 `chat` LLM Span；同批工具共享 STEP，输入为此前可见 user / assistant / tool 消息，输出包含文本及 tool_calls |
| 持久化的完整原生 sandbox execution UUID 和起止 | 一次本地执行对应一个 TASK，使用 `run_task`，不解释为云端 Agent invocation |
| 请求选择的 Skill / 伙伴标识 | `selected_skills` / `selected_partners`，只表示本次选择上下文 |

没有可匹配的本次轨迹时退回已有请求 / 工具观测，不从单独一条任务结束日志制造 LLM。可匹配轨迹的时间推算如下：

- 首轮从客户端提交时间开始；后续轮从前一批工具完成开始。产生本地工具的轮次在该批最早收到调用时结束；最后一轮使用已确认请求或本地执行的结束边界。
- 已有本地工具起止保持原值。原生 `Wait` 结果中完整、合法且位于所属区间内的 `started_at` / `ended_at` 独立形成等待工具区间，避免将等待时间全部计到 LLM。
- 仅有 trajectory 顺序而无时间的中间决策和工具，在相邻已知边界内线性分配时间；不使用文件修改时间或采集时间。源顺序和时间冲突时退回单独的工具事实，不强行拼树。

这些 LLM Span 表示按可见对话重建的逻辑轮次，**时间为客户端边界推算值，不是豆包提供的实际模型执行时长**。使用普通 `LLM` / `chat` 类型与名称，不另加特殊展示标签。CMS 的默认 LLM 调用次数、平均耗时等可能因此包含这些逻辑轮次和推算值；不能将其用作精确模型性能或请求数的测量。可见历史也不等于模型实际完整 prompt，可能缺少系统提示、记忆、压缩和隐藏重试。模型、原生 response ID、usage、成本和模型 finish reason 缺失时省略。

正式版的 `present_files` 交付还会触发 ID 为 `present-files-path-inspection-<UUID>` 的 Bash 路径检查。该检查与 trajectory 中 `present_files` 的调用 ID 不同，属于交付实现细节；精确匹配该 ID 格式和 Bash 名称时跳过，避免额外统计为 Agent 的 Bash 决策。升级前 checkpoint 中待配对的同类检查也跳过。真实 Bash 和其他工具仍按原规则采集；有完整 trajectory 调用及返回的 `present_files` 可形成逻辑工具 Span，其无直接来源的时间使用上述推算方法。

首次 `cot_first_token` 的原生 SSE duration 仅写入自定义 `client_time_to_first_cot_ms`，表示提交到首个推理输出接收的客户端区间，不作为 LLM 耗时或模型 TTFT。模型、Token、成本、finish reason 和云端内部 reasoning 均不补造。

客户端的 `session_success=1` 也可能对应额度通知。所有请求保留 `business_outcome=unknown`；正常接收的根 Span 为 UNSET，明确的客户端错误或取消为 ERROR。本地工具结算状态与本地 TASK 结束不代表业务成功。

## 本地 TASK 与异步关联

原生 `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json` 的 `execution` 给出 `startedAtMs`、`endedAtMs`、`queryMessageId`、`sandboxId`。开始是本地 sandbox 获取回调，结束是释放时文件捕获完成回调，包含本地管理开销。

必须同时匹配新请求的 conversation、local message ID、唯一主请求 sandbox actor，以及 trajectory 中成对 `create_agent` 的无歧义创建关系。一个 execution UUID 只导出一次 TASK；工具只归到时间范围内且 actor/sandbox 完全一致的 TASK，祖先不复制后代工具。

同 query、sandbox 下唯一覆盖子执行、且在根请求区间内的本地父执行构成 TASK → TASK。其余完全位于已观察请求区间内的本地 TASK，依据精确 query 归属挂到根 AGENT；`trace_parent_resolution` 区分本地父执行与所属请求。Span Link 另外保留原根关联，但树结构不依赖后端是否保存 Link。`native_creator_agent_id` 仅表示创建者身份，不充当云端逐次 invocation 父边。

执行区间跨过客户端请求结束、或在请求结束后才开始时，每个完整 execution 导出一棵独立、ID 确定的本地执行 Trace，以 TASK 为根。通过 Span Link 关联原请求 AGENT，并以 `origin_trace_id` / `origin_span_id` 保留可查询的关联；标准执行事实仍使用原请求 Trace ID。其 LLM / STEP / TOOL 使用该独立 Trace 的身份，保留源执行及工具时间。不延长原请求、不复制祖先，也不制造新的 ENTRY / AGENT。元数据只是晚到、实际区间仍在请求内时，继续补入原树。执行开始早于原请求等身份或边界冲突仍拒绝导出。

请求内的子记录先到时等待父记录 30 秒；有本次请求区间内的源时间证明父 Write/Edit 成功时，宽限延长到首次发现后的 120 秒。成功的同内容 Write 不保证产生父快照，等待到期后按已确认请求归属降级，不无限等待；旧 checkpoint 中没有源时间的 Write 见证不延长宽限。后台执行采用独立根，不等待父快照。没有完整或唯一父执行证据时保留原始身份和 `parent_resolution`，不制造中间 Span。客户端仅持久化有被跟踪文件变更的本地执行；纯 Read/Bash、纯云端或未落盘的子 Agent 不保证有 TASK。未归入 Span 的真实工具日志仍保留。

## 内容、边界与可靠性

只读取新日志已确认的 conversation，支持 `Default` 与账号切换后的 `Profile N`，最多检查 16 个 Profile；同一 conversation 在多个 Profile 出现时跳过歧义。轨迹与需求文件只在该会话内读取，不扫描历史、不读取 Cookie、登录缓存或消息数据库，不采集快照中的业务文件正文（首次解析快照 JSON 仍需在预算内读取文件）。

本次需求必须在源请求窗口中唯一；复用时结合原生 user 分隔记录及精确工具 ID 选择本次输出。LLM 输入可以保留同一会话此前的可见历史作为上下文，但不会把历史 assistant 输出再次生成为本次 LLM。原始内容字段最多 64 KiB；每轮输入最多 64 KiB，超出时移除最早完整消息。每个所属请求 / 本地执行最多 64 个 assistant 轮次，展开内容合计最多 512 KiB，超限记录省略数量。相邻重复的无工具最终答复只保留一个可见轮次。

原生 Skill 引用从 `skill://<name>?...` 展开为该客户端 `.doubaowork/agent_mode/workspace/.skills/<name>/SKILL.md` 的绝对路径时，以 Skill 标识和标签识别等价需求。其他指令文字仍须相同，歧义分隔记录拒绝匹配；不进行任意路径、链接或模糊文本匹配。实际消息内容不改写，也不重复追加原始需求和展开后的 user 消息。

缺少源结束事件的请求保留 pending，不以会话切换、首输出或采集时间补造结束。完成扫描有界轮转并保存游标；未收口请求及无效结束元数据不会阻塞后续已结束请求，collector 重启后仍继续公平扫描。

已取得本次需求而最终轨迹尚未落盘时，遥测管道最多等待 2 秒，随后有界降级；不阻塞客户端，也不改变已有请求及本地工具的源时间。Windows 本地回调名 `Bash` 可对应原生 `PowerShell`：两者分别保留，避免误报工具类型。新增历史消息、工具参数和结果均先走统一 InputManager 脱敏，再转换 Span；不在脱敏后重新读取原文。内部轮次内容只用于转换，JSONL 不重复复制整份展开历史。

每个所属请求或本地 TASK 最多导出 64 个 TOOL Span，超出数量写入 `tool_observations_not_in_span`，完整已采集事实仍在 JSONL；缺失一端、身份冲突或非正时间的工具不导出完成事实。原生后台扫描每轮一个会话，最多 64 个 Agent、祖先深度 8。快照另限 8 个账户、128 个执行/文件，单份快照最多 2 MiB；不跟随目录逃逸或符号链接。轨迹总长不再受 2 MiB 限制，读取预算与缓存边界见下文。

增量日志支持半行、重启、轮转、截断与临时不可读。首次启用跳过历史；日志每次最多读 1 MiB、每轮 8 MiB、最新 128 个文件。请求与 sandbox 状态各最多 512 项/24 小时，工具状态最多 4096 项/24 小时，完成去重最多 4096 项/7 天。原生扫描至少间隔 10 秒，日志唤醒每秒合并一次。超限不承诺完整覆盖或端到端 exactly-once。

## 增量处理与性能边界

- 同一 Input 的日志、原生文件与轮次重建共用每轮 8 MiB 读取、4096 条解码/重建工作和约 50 ms 的协作预算；原生读取块为 64 KiB，每 256 条工作让出事件循环。预算耗尽保存内存进度并在后续轮继续，不把延期当作空结果。多文件日志扫描也保留当前位置，完整窗口耗尽预算时给收口工作下一轮预算，避免靠后文件或完成事件饥饿。该时间是协作调度目标，单次文件操作、JSON 解码及收尾仍可能超出。
- 按文件身份、大小、纳秒修改/变更标记复用原生解析结果；不变文件不再打开或读取正文。增长前校验首尾锚点，覆盖、截断、替换或标记冲突则失效重读。JSONL 仅消费完整行，半行单独保留；文件时间只用于缓存校验。
- 每个 actor 保留约 2 MiB 的近期轨迹正文窗口及原始记录位置；早期创建关系与调用索引独立保存。旧上下文可能截断，当前需求分隔记录已离开窗口时不猜测其归属。每条原生 JSONL 记录仍最多 2 MiB，调用索引最多 4096 项。窗口与容量降级写出原因。
- 缓存最多 512 个文件、估算保留内存 64 MiB，非活跃项 15 分钟过期；优先淘汰非活跃会话，再淘汰最早活跃项，扫描中的会话暂受保护。它若单独超限则明确降级。估算缓存字节不等于进程 RSS。已完成快照只缓存 execution 元数据，不保留快照文件正文。
- 轮次输入使用按消息字节计数的有界窗口，不再反复序列化整份历史。重建任务最多 4 项、估算 32 MiB、60 秒过期；长任务使用冻结的已校验源视图分批恢复，避免每轮从头计算。既有 round ID、源记录位置、64 KiB 输入和 64 轮/512 KiB 输出规则保留。
- 原生正文缓存和重建进度不写入 checkpoint。重启后分批重读已确认会话，由持久化日志游标、待完成状态和确定性 ID 恢复；保持既有输出入队与状态提交顺序。空闲轮只读状态，实际游标、关联、完成记录或 TTL 清理变化时才提交。

`Doubao Work native cache statistics` 调试日志提供累计正文读取、解析行、命中、失效、淘汰、估算保留字节和文件数；`InputRuntimeAccumulator` 包含原生日志/正文读取量，非正文元数据查询仍有开销。当前配置层已弃用并忽略 `captureMessageContent`，本适配不另行恢复 content-off 开关；内容仍走统一脱敏。

可用 `node tests/performance/doubao-work-rounds.perf.mjs` 在独立子进程重跑 4k/8k/16k 合成历史阶梯，输出 wall/CPU、定时器延迟和 RSS；这衡量 collector 重建开销，不代表客户模型响应耗时。

## 配置与验收

| 平台 | 源日志 |
|---|---|
| macOS | `~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log` |
| Windows | `%LOCALAPPDATA%/DoubaoWork/User Data/sdk_storage/log/saman_YYYY.MMDD.N.log` |

Windows 缺少 `LOCALAPPDATA` 时使用 `~/AppData/Local`；macOS 时间保留微秒，Windows 保留毫秒。`listeners.doubao-work.logDir` 可指定其他只读源目录；输出 `dataDir` 独立。

`logDir` 只覆盖日志读取和监听目录；原生会话与 `coding/snapshot` 仍从平台默认的豆包数据目录读取，不从自定义日志目录向上推导。Agent 检测使用同一平台路径解析，Windows 同样遵循 `LOCALAPPDATA`。

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

Agent 使用 `detection-only`。关闭 listener / Agent 即停止采集。Skill 的选中不证明实际加载；独立工作伙伴页面、云端完整 Agent 生命周期仍无覆盖。

真实验收分别核对源日志、标准 JSONL、OTLP 和 CMS 回读，确认每轮 I/O、同批并行工具、ID / 时间 / 归属、TASK 唯一性与异步 Link。根请求的完整可见轨迹形成 ENTRY → AGENT → STEP → LLM / TOOL；本地执行片段中的 STEP 归属对应 TASK，不冒充完整云端 Agent invocation。缺少轨迹的本地 TOOL 仍直接挂在原所属 AGENT 或 TASK 下，保留 `genai.observed-tools.v1` 部分观测契约。标准事件日志保留 call/result，已导出的工具不重复复制为父 Span events。

原有完整 Pilot ReAct validator 保持不变，不增加产品特例。缺少轨迹时直接挂在 AGENT/TASK 下的 TOOL、TASK 下的局部 STEP，以及独立 TASK 根，仍可能超出该 validator 的完整 Agent 树契约；独立本地执行按局部观测解释，不宣称完整 Agent 拓扑通过。保留实际失败和推荐属性缺口。内容与推算算法的核验不等于精确模型遥测通过；同时回查 CMS 默认调用次数及耗时统计，报告实际影响。

本地观测日志用 `local_execution_phase` 表示资源起止，以 `root_turn_id` 保留关联；不写客户端 `gen_ai.turn.start/end`，也不创建新的客户端 turn。

## Mac 消息流验证

2026-10-27 在正式版 macOS 2.34.1 / Chromium 147 上进行了八个真实场景验证：纯文本、顺序 Write → Read → Write → Read、双子 Agent、组织者异步委派、Skill 与会话复用、后台工具失败、用户取消、并行工具错误恢复。连续四个工具调用只对应一个回复 ID，消息流的结束边界覆盖整个同步回复，不能据此拆出逐次 LLM 调用。

主页面与 launcher 各出现一次 `/chat/completion` 请求，但具有相同 local message ID 和回复 ID，必须识别为同一消息的两条物理传输。`STREAM_MSG_NOTIFY`、`STREAM_CHUNK` / `CHUNK_DELTA`、`SSE_REPLY_END` 提供消息和界面块的身份、内容与终止事实；工具界面块的 `is_finish` 不是模型调用的完成事件。模型字段 `38` 是内部枚举，`context_window_usage` 是上下文占用，两者均不转换为真实模型名或本次计费 Token。

多 Agent 会在同步回复后使用 `/chat/async/chunk_stream`。本轮已抓到完整组织者异步流并核对子 Agent 的界面结果；异步接收身份与同步请求、线程身份不同。使用本次已观察回复中的 thread ID，结合该线程 SDK 的 `on_thread_message_session_start.session_id` 才能确定对应 async task。SDK 事件即使在新任务中也带 `resumed=1`，表示接收生命周期，不能解释为 Agent 或模型的真实执行起止。已观察的组织者异步回复仍跨越多个工具决策，没有暴露逐次模型身份。当前结论只针对已观察路径，不排除客户端其他接口能提供更多信息。

以下为工具 Span 改动前的历史基线。该版采集产物通过隔离 dataDir 运行，在 CMS2 回读到四个客户端请求、八个 ENTRY/AGENT Span，本地与云端的身份、父子关系、当前输入输出、Skill 标识和已附工具事件一致，原始查询无重复。未修改的通用 validator 为 `PASS_WITH_WARNINGS`：零错误，仍缺 LLM、Token、部分推荐属性及输出消息 finish reason。后台晚到的工具事实保留在标准日志，不拉长同步请求或制造中间 STEP。该结果证明已导出部分的数据质量，不是完整 ReAct / LLM 验收。

Claude Code 的 fetch intercept 在真实 `/v1/messages` 请求上补充每次 HTTP attempt、SSE response ID 与起止，另有 transcript 的时间、模型和 usage。豆包页面则将消息请求交给缓存的自定义 fetch，再通过 `fetch-stream-for-im` 原生 MessagePort 发送。只包装全局 `window.fetch` 可能漏采；包装同一个收发入口也不会自动得到云端内部的逐次模型请求。

仓库保留一个开发诊断命令，要求 Node.js 22+ 和已经启用的本机回环 CDP：

```bash
node scripts/diagnostics/doubao-work-network-probe.mjs \
  http://127.0.0.1:9236 DBW_UNIQUE_TEST_20261027 /tmp/doubao-new-capture 120
```

等待 `Ready` 后，在新任务正文加入相同的唯一测试标识。输出目录必须不存在。脚本只启用 Network 观察和 [CDP 响应流读取](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent)，不暂停、重放或修改业务请求；只保存本次标识匹配的消息文本及白名单协议字段，不保存 headers、Cookie、签名 URL 或账号元数据。最多运行 300 秒、连接 16 个本产品页面、保存 4 MiB，每条流最多 1 MiB；超限或不支持流读取时明确记录缺口。

`network.jsonl` 是诊断事实，不是标准 GenAI 事件或可直接上报的 Span。重复物理传输保留，使用消息身份对照；不按请求数、工具块数或 `SSE_REPLY_END` 数量统计 LLM。观察到 `FETCH_STREAM.fetch_key` 时跟随对应 async task。也可提供第六个参数作为绝对路径的 task scope JSON 文件，内容为本次已有原生证据的 task ID 数组；最多 8 KiB / 128 项，每 250ms 刷新。已有 async 请求会在精确匹配后才开始读取流，其余正文不保留，绑定晚到或缓冲超限时可能缺失数据。

对 scope 文件的关联必须先证明本次回复 thread ID 与 SDK 线程 session ID 的关系；人工 scope 的来源单独标为 `explicit_task_scope`，不充当 Agent 父边或模型调用身份。不猜测尚未证明的线程/任务映射。未知协议仅记录事件名，异步 snapshot 正文尚未适配。该脚本不接入常驻 collector、不自动开启调试端口、不上报 CMS；正式采集仍使用上文的被动文件 Input。测试结束后恢复普通启动并确认临时调试端口关闭。
