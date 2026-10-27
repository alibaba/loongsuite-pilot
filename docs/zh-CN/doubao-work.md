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

同 query、sandbox 下唯一覆盖子执行的本地父执行构成 TASK → TASK。其他本地根 TASK 不制造委派 TOOL / AGENT，也不延长已结束的客户端请求，而以 Span Link 关联原根 AGENT；同一 trace 可有 ENTRY 和本地 TASK 两个根。`native_creator_agent_id` 表示创建者身份，不能当成逐次 invocation 父边。真实工具日志和不可推断的云端委派仍可分别核查。

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
