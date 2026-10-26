# 豆包工作任务、本地工具与子 Agent 观测（实验性）

`doubao-work` 被动读取 macOS 和 Windows 豆包工作的客户端日志，不向客户端注入 Hook、插件或连接器，不修改登录状态和设置。已观察的协议基线为 macOS 2.33.10 和 Windows 2.25.18；普通豆包和云端内部执行不在本阶段支持范围内。高阶原生能力取决于所安装客户端版本实际暴露的证据。

## 能力范围

Pilot 关联客户端消息提交和结束事件，输出同一会话、轮次下的一对任务边界事件（`other`）和 ENTRY → AGENT Trace。边界采用源提交时间和客户端会话结束日志时间；提交时间保留源毫秒精度，日志时间在 macOS 上保留微秒、Windows 上保留毫秒精度。它表示客户端请求轮次，不能用来声称云端任务及其内部步骤已全部完成。

不提取 Prompt、回答、reasoning、工具参数/结果。满足下述原生依据时，可生成首输出观测的 STEP → LLM；模型、Token、成本和模型 TTFT 仍不可得。`自动` 模型选项不是真实模型 ID。

## 首次模型输出观测

只接受 `flow_message_time` 中 `metric_scene=sse`、`ev_name=cot_first_token`、`ev_type=query_duration`、同步且非恢复的首次标记。原生任务 ID 必须唯一关联已观察到提交的新请求。起点为原生 `query_send_timestamp`，终点为该时间加原生 `duration`；客户端生产者定义此 duration 为 SSE 接收时间减提交时间。日志写出时间只作为上界，读取时间、渲染时间和文件 mtime 均不参与推断。

导出 `chat (first reasoning output only)`，标记 `observation_scope=native_first_model_output`、`llm_boundary=client_submit_to_first_cot_receipt`、`llm_completeness=first_output_only`。这段时间包含排队、上下文处理与网络等待，不能当作完整模型调用耗时或模型 TTFT；后续 ReAct 轮次、完整流式输出及子 Agent 的 LLM 仍无覆盖。没有该标记、只有答复/加载/结束标记、恢复/异步标记、冲突或缺少提交关联时，不生成 LLM。已导出请求之后才到的标记不补推。

模型名、模型响应 ID、finish reason、Token 以及思考正文均不猜测；native answer ID 保留为原生消息属性。源事件 ID 只用于观测去重，不解释为模型调用 ID。首次输出之后用户取消任务，不会把已观察到的 LLM 首输出改成失败。该区间的 STEP 是局部观测，后续本地 TOOL 仍直接挂在有原生归属证据的 AGENT 下。

客户端可在返回算力/订阅限制通知后仍记录 `session_success=1`。因此对所有轮次保留 `business_outcome=unknown`，正常接收的根 Span 使用 UNSET 状态；源端明确报告客户端失败或取消时，根 Span 标为 ERROR。这不是对业务任务成功率的推断。

标准事件与 OTLP Resource 包含这些低基数属性：

| 属性 | 值 |
|---|---|
| `loongsuite.doubao_work.observation_scope` | `client_message` |
| `loongsuite.doubao_work.business_outcome` | `unknown` |
| `loongsuite.doubao_work.client_outcome` | `received`、`ended`、`error` 或 `cancelled` |

Agent type/framework 为 `doubao-work`，Agent system 为 `doubao`，provider 为 `bytedance.doubao`。会话使用源 `conversation_id`，轮次使用源请求会话 ID；不将设备或缓存目录标识当作用户 ID，沿用 Pilot 配置身份和 hostname 兜底。

## 工具、技能与子 Agent

| 能力 | 支持边界 |
|---|---|
| 本地工具 | 精确匹配前端 `toolcall` 的 `received` 与 `execution_settled`，输出 `tool.call` / `tool.result` 和 AGENT 下的 TOOL Span；支持并行配对与采集中途重启 |
| 所选技能/伙伴 | 原生 `mention_skill_list` / `mention_partner_list` 的受限标识数组，分别写入 `loongsuite.doubao_work.selected_skills` / `selected_partners`；仅表示该请求的选择上下文 |
| Skill 实际加载 | 当前日志未提供可验证的独立加载起止，不把选中技能解释为 `skill.use` 或 SKILL/TOOL Span |
| 子 Agent 本地执行片段 | 原生 sandbox actor 关联本次主请求；trajectory 中成对 `create_agent` 调用/结果证明祖先关系；每对本地工具回调生成独立子 AGENT 及祖先观测 Span，支持嵌套、复用、晚到和 checkpoint 恢复 |
| 完整云端子 Agent 生命周期 | 仍缺少所有子 Agent 的完整执行起止；纯云端计算或无成对本地工具回调的 Agent 不生成生命周期 Span |
| 独立“工作伙伴”页面 | 独立的 aily 云端任务入口；本地客户端消息日志不覆盖其任务生命周期，不声称支持其 Trace |

本地工具时间表示客户端收到调用到本地执行结算的观察区间，包含分发/确认等待，不等于云端模型发起到接收结果的全链路耗时。原生工具名、调用 ID、受限状态与正的毫秒耗时被保留；不读取命令、参数、输出或原始错误。`success` 只表示原生本地执行结算状态，不推断业务结果或 Bash 命令退出码。

TOOL 的 `loongsuite.doubao_work.tool_boundary=client_received_to_execution_settled` 标识这个边界。由于没有后续模型轮次边界，工具分支保持 ENTRY → AGENT → TOOL。通用 validator 仅针对这个明确标识和 Doubao framework 接受 TOOL 直接挂 AGENT；其他 Agent 的 STEP/LLM 检查保持严格。该边界也明确不包含工具参数，缺少参数按源不适用记录。旧 validator 若要求 STEP → TOOL 或无条件要求参数，会报告契约不兼容；验收同时保留原始失败结果与本候选公开契约校验，普通工具的参数检查不放宽。

普通任务内工具缺少一端、ID/工具名冲突、没有唯一请求归属或超出客户端请求时间时省略。能以原生 sandbox 与委派图唯一关联的子工具，可独立导出晚到片段；其他后台调用不补推归属。云端 `calculator`、`web.fetch`、`create_agent` 等仅在无时间的轨迹中出现时不生成工具耗时。子 Agent 验收需分别覆盖复用、嵌套、晚到与重启，不能仅由普通任务 Trace 证明。

## 子 Agent 的时间与父子关系

原生数据源增加 `Default/.doubaowork/agent_mode/workspace/.sessions/<conversation>/agents/*/system/trajectory.jsonl`，相对客户端数据根目录解析。只读本次日志已经确认的 conversation，不扫描历史会话。`create_agent` 必须有同调用 ID 的成功结果，结果的 `parent_id` 必须匹配调用者文件；循环、多父、半行、临时不可读或超限时保留工具状态并等待。

同一 sandbox 的原生命令 actor 必须有且仅有一个已采集主请求，子工具及各层祖先 actor 必须存在于该 sandbox，委派图必须能回到唯一 main Agent。关联不依靠目录排序、文件 mtime 或“离哪个请求最近”。主请求结束后保留其上下文，root AGENT 使用确定性 Span ID。

每次成对本地工具调用生成一个不可变观测片段，拓扑为 ENTRY → 主 AGENT → organizer AGENT → 子 AGENT → TOOL。没有可测量的委派工具起止，因此不插入 `create_agent` TOOL。片段起止精确保留该工具的原生 `received` / `execution_settled` 微秒时间；祖先 Span 覆盖相同的后代工具区间，并标记 `timing_basis=descendant_local_tool`，叶子为 `own_local_tool`。

`observation_scope=native_local_tool_fragment`、`agent_boundary=native_local_tool_interval`、`fragment_id`、原生 Agent/parent/thread/creation-call ID，以及 `relation_basis=native_create_agent_ancestry` 标识此契约。这里表达原生创建祖先关系，不推断不可见的逐次云端 dispatch。一个 Agent 可有多个观测片段；这不是完整 Agent 调用总时长，也不能用祖先区间重复累计工具耗时。每片段有独立 turn ID 和确定性事件/Span ID；恢复或日志重投不移动原有时间。请求级选择技能不继承到子 Agent。

`assignment.md` 的需求时间及 `board.md` 的全局更新时间不能普遍充当子 Agent 执行起止，线程面板补收也不是云端执行时间。这些字段没有被用来制造 Span。通用 validator 只对带完整原生关系与片段标识的 Doubao AGENT → AGENT 边接受异步结束，其他关系仍检查父子时间包含。

每轮最多扫描一个已知会话、64 个 Agent、每文件 2 MiB、总计 8 MiB，最大祖先深度 8；源失败不删除已完成配对。主请求与 sandbox 上下文各保留 512 项/24 小时，片段去重最多 4096 项/7 天。缺少原生证据则不生成子 Span。

## 原生 sandbox 独立执行

客户端 `entry-moa` 的执行管理器为本地 Agent 上下文生成独立 UUID，并在 `coding/snapshot/<account>/<conversation>/<executionKey>/<agentId>.json` 的 `execution` 中保存 `startedAtMs`、`endedAtMs`、`queryMessageId` 和 `sandboxId`。这是另一类可验证的数据源：开始是 `getOrCreateSandbox` 返回后的原生回调，结束是释放上下文时完成文件捕获后的原生回调。起止直接取这两个毫秒字段；文件 mtime、首次读到时间和工具区间均不参与计算。

只有客户端实际落盘的完整记录才能生成 `observation_scope=native_sandbox_execution` 的独立 AGENT Span。`native_execution_id` 区分同一 Agent 的不同执行；`native_query_message_id` 必须精确匹配新采集主请求的 local message ID，同一 sandbox 的原生命令 actor 也必须一致。创建轨迹提供原生父 Agent 身份；同一 query、sandbox 中只有一个覆盖子执行的父执行记录时，才链接其独立 Span。子快照先到且同一 sandbox 的父 Agent 已有成功 Write/Edit 工具证据时，保留该证据并等待父执行记录，受既有 24 小时/4096 项关联状态及主请求保留上限约束；不以 30 秒观察窗口推断父执行已结束。没有父变更证据时保留 30 秒等待窗口；父记录仍缺失、已到但有歧义或不覆盖子执行时链接已观察的主请求，标记 `parent_resolution=root_request_ancestor` 并保留真实父 Agent ID 与祖先链，不制造中间 Span。已导出的父边不因后续落盘而重写。

该记录的边界为 `agent_boundary=native_sandbox_get_or_create_to_release`，时间依据为 `timing_basis=native_execution_startedAtMs_endedAtMs`。客户端只持久化具有被跟踪文件变更的执行；纯 Read/Bash、无本地工具或未保存记录的云端子 Agent 没有完整执行覆盖。此 Span 表达本地 sandbox 生命周期，包含释放时的捕获开销，不能视为云端完整推理耗时或逐次云端 dispatch 证明。现有 `native_local_tool_fragment` 继续表达工具观测；两种 scope 不可混为调用次数或累计耗时。

只扫描新请求已确认的 conversation，每轮最多一个会话、8 个账户目录、128 个执行/文件，每文件 2 MiB、总计 8 MiB；不沿符号链接读其他目录。只投影 execution 的受限身份与时间，账户 ID、文件路径和文件正文不输出。半写、临时不可读或冲突保留 checkpoint 重试；执行 ID 去重最多 4096 项/7 天，恢复不回放已完成执行。该 checkpoint 仍遵循 InputManager 的队列接收边界，不承诺输出端 exactly-once。

## 配置与发现

默认数据源：

| 平台 | 日志目录 | 文件与头部 |
|---|---|---|
| macOS | `~/Library/Application Support/DoubaoWork/sdk_storage/log` | `saman_frontend_YYYY.MMDD.N.log`，`FRONTEND(0)`，六位小数 |
| Windows | `%LOCALAPPDATA%\\DoubaoWork\\User Data\\sdk_storage\\log` | `saman_YYYY.MMDD.N.log`，`CONSOLE(0)`，三位小数 |

Windows 未设置 `LOCALAPPDATA` 时使用 `~/AppData/Local`。客户端须已产生这些日志；Pilot 不自动启用调试日志。首次启用跳过已有历史，此后仅采集新增且起止均被观察到的轮次。

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

`listeners.doubao-work.logDir` 可覆盖只读源日志目录（支持 `~`），用于自定义本机安装目录。该目录与 Pilot 的输出 `dataDir` 不同。`agents.d` 使用 `detection-only`，没有需要安装、修复或卸载的宿主 Hook；停用 listener 或 Agent 即停止采集。

使用目录变更唤醒和轮询兜底；日志唤醒合并到每秒最多一次，原生图和快照扫描独立限制为每 10 秒最多一轮，避免高频日志反复触发大文件读取。首输出复用已有日志增量读取，不新增数据源或客户端回调；无关 SDK 事件在 JSON 解析前过滤。checkpoint 保留完整行 offset、文件边界指纹、待关联请求和已完成轮次。支持半行、重启、轮转、原地截断后增长和临时不可读；首次启用前的请求不从单独结束事件重建。单次读取最多 1 MiB，每轮最多 8 MiB，最多读取最新 128 个日志文件；超长行跳过至换行。待关联请求最多 512 个/24 小时，工具配对状态最多 4096 个/24 小时，完成去重最多 4096 个/7 天。超出边界不承诺完整采集或 exactly-once。

日志缺失、协议变更或无稳定关联/时间时，不生成猜测的 Trace。适配器只提取受限身份、状态与原生委派关系，不读取浏览器 Cookie、认证缓存或消息数据库；原生轨迹中的 Prompt、命令、输出及错误正文不进入事件或 Span。仍遵循统一身份处理与脱敏配置。

验收使用真实 GUI 新交互，设置 `E2E_JSONL_STRICT=1` 和 `E2E_JSONL_AGENT_FILTER=doubao-work`。任务及本地工具校验通过不代表云端 LLM、Skill 加载或完整子 Agent 生命周期接入通过；云端回读与本机源、事件、Span 和接收端验证分别记录。
