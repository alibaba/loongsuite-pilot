/**
 * 解析 ai-agent stdout 日志 → 轨迹骨架
 *
 * 关键约束：日志可达数百 MB（实测 329MB），必须流式逐行处理。
 * 且 `model_mgr` 模块约占 90% 行（心跳刷屏），先做廉价 includes() 预筛，
 * 再走正则，避免把 CPU 全烧在无用行上。
 */
import fs from 'node:fs';
import readline from 'node:readline';

/** 行级预筛关键字：命中任一才进入正则解析 */
const KEEP_HINTS = [
  'add timing event',
  '[Timing] events for trace_id',
  '[ToolcallService] Run tool',
  // 工具真实起点（毫秒级）——比 end-cost 反推和 state.json 的秒级 started_at 都准
  '[ToolcallService] Start run tool',
  // LLM 侧的 tool call id（call_xxx）——与 hook 的 tool_use_id 同值，精确 join 的 key
  '[execute_toolcall]',
  '[RunCommand]',
  'run_command finish',
  'model_info: CustomModel',
  // 服务端 LLM 请求：每一次 = 一次推理 = 一次 ReAct 迭代（迭代数的权威依据）
  '[HTTPClient] request url',
  '[ChatHandler::router]',
  'ServerHistoryCache',
  // ReAct 迭代分隔符：每提交一批工具结果，服务端就产出下一步
  'commit_toolcall_result] endpoint',
  // 相位标记：补齐叶子 span 之间的空白窗口（流式到达 / 审批 / 提交 / 收尾）
  'ToolCall arrived',
  '[FileOp][confirm]',
  'need_manual_confirm',
  'submit_toolcall_result]',
  'products_accumulation]',
  'chat_turn_finish',
  // 采集器自身的开销（TRAE 同步阻塞等 hook 返回）
  'ToolingHookCommandRunner',
  // LLM 请求参数 / 子智能体谱系
  '[ModelConfig] Received config_name',
  'agent_run_info:',
  // 真实的子智能体委派：生命周期括号、每次推理的归属、派发工具真名、声明成员
  '[SubAgentCreate]',
  '[SubAgentFinish]',
  '[AgentStatus] received',
  '[SSE_routing] NoNeedExecute',
  'fetching sub_agent',
  // Harness 装配相位：子智能体名册 / MCP 扫描 / 规则护栏 / 技能引擎 / 记忆开关
  'get_custom_agent_infos',
  '[McpService] merged mcp server count',
  '[RawRules]',
  '[SkillTool]',
  'enable_chat_memory_user_config',
  '[ContextUsage] received from cloud',
  // 联网搜索：查询词、抓取目标清单、逐页抓取、收尾
  'stage=tool_entry',
  'request_search_references completed',
  'crawler targets',
  '[RemoteFetchStrategy] fetch_single completed',
  'all steps completed',
  // 等用户手动确认的阻塞时间（人的思考时间，不是 Agent 的耗时）
  'PendingInteractionRegistry',
  'manual_confirm_reason',
  // 推理流收尾与下一个工具的派发（解释工具之间的百毫秒缝隙）
  '[FileOp][dispatch]',
  'plan final token cost',
  'plan thought first token cost',
  // 子智能体交还前的汇报阶段（独立的 summary 模型配置）
  '\\"config_name\\":\\"summary\\"',
];

/**
 * 相位标记表：[正则, 轨迹里的事件名]。
 * 这些时刻不构成 span（无起止区间），但能解释叶子 span 之间的空白窗口，
 * 否则轨迹上会出现数百毫秒无交代的断层。
 *
 * ⚠️ 全部锚定 `^`，必须匹配**消息体开头**（TRAE 自己的日志消息一律以 `[Module]` 起头）。
 * 不能对整行做无锚点搜索：`[commit_toolcall_result]` 那行的 payload 会把工具结果
 * **原样回灌**进日志，被读文件里的任意文本都会伪装成 TRAE 自己的日志行。
 * 实测踩过：Agent 读了一份讲 TRAE 日志的文档，文档里引用的
 * `Run tool SearchCodebase finished, status: Success, cost: 724ms`
 * 就凭空变成了一次真实的工具调用。
 */
const PHASE_MARKERS = [
  [/^\[handle_stream\] ToolCall arrived: tool_name=([^,]+)/, m => `toolcall.streamed:${m[1]}`],
  [/^\[FileOp\]\[confirm\] entering confirm flow for tool=([^,]+)/, m => `tool.confirm.begin:${m[1]}`],
  [/^\[need_manual_confirm\].*will auto run/, () => 'tool.confirm.auto_run'],
  [/^\[submit_toolcall_result\]/, () => 'result.submit'],
  [/^\[run_finish\]\[products_accumulation\] Entry point/, () => 'turn.finish.begin'],
  [/^\[snapshot_v2\]\[[0-9a-f]+\] chat_turn_finish/, () => 'turn.finish.snapshot'],
  // 下两条专治工具之间的百毫秒缝隙。实测那些缝隙里发生的是：
  // 工具 A 跑完了，但本次推理的流式响应还没收完（TRAE 边流式接收边执行），
  // 等流收尾后才派发工具 B。不标出来就是 90~550ms 的无交代空白。
  [/^plan final token cost: (\d+)ms/, m => `llm.stream.final_token:${m[1]}ms`],
  [/^\[FileOp\]\[dispatch\] tool=([^,]+), extracted file_paths=/, m => `tool.dispatch:${m[1]}`],
  // 下三条交代子智能体交还前后的长空白（实测 40.7 秒）。那段时间里：
  // 子智能体工具跑完 → 用独立的 `summary` 模型配置写汇报（实测 33.7 秒）
  // → SubAgentFinish 交还 → 主智能体接着用**同一个**响应流继续输出。
  // 不标就是一段四十秒的无交代空白，最容易被当成采集漏了东西。
  [/^TimingCost:.*\\"config_name\\":\\"summary\\"/, () => 'subagent.summary.begin'],
  [/^\[SubAgentFinish\] received: agent_run_id=\S+, agent_id=([^,]+),/, m => `subagent.finish:${m[1]}`],
  [/^plan thought first token cost: (\d+)ms/, m => `llm.stream.first_token:${m[1]}ms`],
];

const RE = {
  // 行首 ISO 时间 + 级别 + 可选 span 路径 + 模块
  head: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+\d{2}:\d{2})\s+(INFO|WARN|ERROR|DEBUG)\s+(?:([a-z_0-9:]+):\s+)?([a-z_0-9:]+):/,
  traceId: /trace_id="([0-9a-f]{32})"/,
  // 同上，但用于取行内**最后一个**匹配（tracing 字段在行尾）
  traceIdAll: /trace_id="([0-9a-f]{32})"/g,
  // add timing event trace_id=timing_events_<tid>_chat rs_01_chat_begin=1786954120259 delta=0
  timingAdd: /timing_events_([0-9a-f]{32})_([a-z_]+)\s+(rs_[0-9a-z_]+)=(\d+)\s+delta=(\d+)/,
  // [Timing] events for trace_id: timing_events_<tid>_chat, { ...json... }
  timingFinal: /^\[Timing\] events for trace_id:\s+timing_events_([0-9a-f]{32})_([a-z_]+),\s*(\{.*)$/,
  // Run tool Grep finished, status: Success, cost: 16ms
  tool: /^\[ToolcallService\] Run tool (\S+) (finished|failed), status: (\w+), cost: (\d+)ms/,
  // [ToolcallService] Start run tool `"LS"` —— 工具真实起点，毫秒级
  toolStart: /^\[ToolcallService\] Start run tool [`"]+([A-Za-z_][A-Za-z_0-9]*)[`"]+/,
  // [execute_toolcall] toolcall_id=call_EboW9tUhkDKA4Kjf3to26KUn, name=LS, agent_run_id=..., is_ok=true
  // 内部终止工具 finish 的 id 为空，所以 id 部分用 * 而不是 +。
  // agent_run_id 用于把工具归属到具体的 agent run（子智能体会是不同的 run）。
  execToolcall: /^\[execute_toolcall\] toolcall_id=([^,]*), name=([^,]+), agent_run_id=([^,]*)/,
  // [RunCommand] command completed, command_id: job-xxx
  cmdCompleted: /^\[RunCommand\] command completed, command_id: (job-[0-9a-f]+)/,
  // run_command finish, toolcall_id: 6a82c1a9e5152afe53a96182
  cmdFinish: /^run_command finish, toolcall_id: ([0-9a-f]{24})/,
  // [RUN_CMD_S] <命令原文>
  runCmdText: /^\[RUN_CMD_S\]\s+(.*)$/,
  // session_id 两种形态：ObjectId 24hex 或 UUID
  sessionId: /session_id[:=]\s*(?:Some\()?"?([0-9a-f]{24}|[0-9a-f-]{36})"?/,
  // model_name: "aliyuncs//qwen3.7-max"
  modelName: /model_name:\s*"([^"]+)"/,
  displayModel: /display_model_name:\s*Some\("([^"]+)"\)/,
  provider: /provider:\s*Some\("([^"]+)"\)/,
  agentType: /agent_type=Some\("([^"]+)"\)/,
  // [commit_toolcall_result] endpoint=... —— 一次 ReAct 迭代的终点
  commitResult: /^\[commit_toolcall_result\] endpoint=/,
  // 服务端推理请求：create_agent_task 是首次，commit_toolcall_result 的响应就是下一次流。
  // 这两者的总数 = 本轮真实的 LLM 调用次数，比「commit 数 + 尾窗口启发式」可靠。
  llmRequest: /^\[HTTPClient\] request url \S*\/api\/agent\/v\d+\/(create_agent_task|commit_toolcall_result)/,
  // 提交载荷中的工具结果（非 RunCommand 工具的结果唯一本地来源）
  toolcallResp: /"toolcall_id":"([^"]+)","toolcall_name":"([^"]+)","toolcall_resp":/,
  // [ModelConfig] Received config_name=..., model_name=..., max_turn=Some(500),
  // prompt_max_tokens=Some(936000), max_tokens=Some(64000), extra_config=Some(Object {...})
  // —— 本地可得的**真实 LLM 请求参数**，与服务端拼装的 prompt 不同，这些是客户端定的。
  modelConfig: /^\[ModelConfig\] Received config_name=([^,]+), model_name=([^,]+), max_turn=(\S+?), prompt_max_tokens=(\S+?), max_tokens=(\S+?),/,
  // 子智能体谱系：TRAE 把一次 agent run 的谱系信息成组打在同一行。
  //
  // ⚠️ 【实测推翻】这一行**不能**用来判断有没有委派子智能体：真实调用过 Search
  // 子智能体的会话里，它的 subagent_type / agent_call_id / parent_agent_run_id
  // 依然全是 None。它只描述「本次 create_agent_task 请求」的谱系，而子智能体是
  // 服务端在这次请求的响应流里派生的，客户端建任务时还不知道。
  // 真正的委派信号是下面的 SubAgentCreate / SubAgentFinish。
  agentRunInfo: /^\[do_create_cloud_agent_task\] agent_run_info: subagent_type=(\S+?), task_id=(\S+?), is_async=(\S+?), agent_call_id=(\S+?), parent_agent_run_id=(\S+?), agent_run_id=(\S+?) /,
  // 子智能体的生命周期括号。Create 开、Finish 合，Finish 一行同时给出
  // 子智能体类型（agent_id，实测 search）与**派发它的父工具调用 id**，
  // 后者就是把子智能体挂回父 trace 的连接点。
  subAgentCreate: /^\[SubAgentCreate\] final render_mode_mapping for agent_run_id=([0-9a-f-]{36})/,
  subAgentFinish: /^\[SubAgentFinish\] received: agent_run_id=([0-9a-f-]{36}), agent_id=(\S+?), toolcall_id=(\S+)/,
  // 每次流式响应收尾时上报「这次是谁在跑」。与 `plan final token cost` 同刻，
  // 是把 STEP 分给主/子智能体的**权威依据**：子智能体的推理不经过本地
  // commit_toolcall_result，光看 HTTP 请求分不出归属。
  agentStatus: /^\[AgentStatus\] received: \[AgentStatusItem \{ agent_run_id: "([0-9a-f-]{36})", status: "(\w+)", run_mode: (?:Some\("(\w+)"\)|None)/,
  // 派发子智能体的工具真名。ToolcallService 只会把它报成 no_need_execute
  // （因为不在本地执行），真名（实测 search）只有这里有。
  sseNoNeedExecute: /^\[SSE_routing\] NoNeedExecute: tool_name=([^,]+), toolcall_id=([^,]+), agent_run_id=([^,]+), require_local_execution=(\w+)/,
  // 声明侧：本次请求带上了哪些子智能体成员（日志侧证据，不依赖读 state.vscdb）
  customAgentSub: /^\[get_custom_agent_infos\] fetching sub_agent: (\S+)/,

  // ---- Harness 装配相位 ----
  // 【实测】每个 trace 恰好装配一次，在首次推理请求之前的 ~20ms 内完成
  // （Trace1 13:00:26.988→27.010 = 22ms，Trace2 19ms），顺序稳定：
  //   名册 → MCP 扫描 → 规则护栏 → 技能引擎 → 记忆开关 → 首次请求
  // 这段时间短到不值得建 span（细到看不见），但**装配出来的内容**是
  // 「这个 Agent 带着什么能力上场」的唯一本地证据，所以落成 AGENT span 属性。
  harnessBegin: /^before get_custom_agent_infos, agent_id=(\S+)/,
  // members_count 是声明的子智能体成员数；total_agents 含主智能体自己
  rootAgentMembers: /^\[get_custom_agent_infos\] got root_agent, members_count=(\d+)/,
  agentListBuilt: /^\[get_custom_agent_infos\] agent_list built, total_agents=(\d+)/,
  mcpScanBegin: /^\[get_custom_agent_infos\] before read_all_mcp_servers/,
  mcpScanEnd: /^\[get_custom_agent_infos\] after read_all_mcp_servers/,
  // ⚠️ MCP 服务器数量这行**不带 trace_id**（实测 9 次全无），而且比
  // `before read_all_mcp_servers` 还早 ~37ms（读的是缓存结果）。
  // 只能按「时间落在本轮自己的窗口内」归属，见 attachTurnLocalMcp。
  mcpCount: /^\[McpService\] merged mcp server count: (\d+)/,
  // 规则护栏：should_mask 是脱敏开关，raw_rules_max_chars 是注入上限（实测 100000）
  rawRules: /^\[RawRules\] global_rules=(\d+), project_rules_types=\[([^\]]*)\], should_mask=(\w+)/,
  rawRulesChars: /^\[RawRules\] pre_truncate=(\d+), post_truncate=(\d+), raw_rules_max_chars=(\d+), total_chars=(\d+)/,
  // 技能引擎：三级路径回退。
  // ⚠️ `fallback to global path` 是**成功**不是失败——实测
  // ~/.trae-cn/builtin/global/skills/ 里那 6 个技能确实在。而
  // `not found in model path ... or global path` 之后还会再试
  // ~/.trae-cn/builtin_skills/（AB 配置下发的那批），所以每个技能的状态
  // 必须以**最后一条**结论为准，中途的 not found 不能当最终结果。
  skillLookup: /^\[SkillTool\] find_skill_path: looking for builtin skill '([^']+)', agent_type=(\S+), config_name=(\S+)/,
  skillFound: /^\[SkillTool\] find_skill_path: found (local builtin|global) skill '([^']+)' at '([^']+)'/,
  skillFallback: /^\[SkillTool\] find_skill_path: fallback to global path '([^']+)' for skill '([^']+)'/,
  // 被门控裁掉的技能（本 session 两轮都是 0 个，其他轮次实测有 digital-avatar-creator / dynamic-ui）
  skillRemoved: /^\[SkillTool\] Removed (?:builtin )?(\S+) skill from (?:runtime )?skill list(?:.*?because (.+?))?$/,
  // 记忆系统：服务端记忆，本地只有开关可见（内容拿不到）
  memoryConfig: /^\[create_agent_task\] enable_chat_memory_user_config=(\S+), enable_core_memory=(\w+)/,
  // 云端回执：环境上下文是否真被用上、哪些文件规则被渲染进了 prompt。
  // ⚠️ 异步且**不在装配窗口内**（实测 Trace1 的第二次落在推理中途 90 秒处），
  // 也可能一次都没有（Trace2 就是 0 次），所以不能当必填字段。
  contextUsage: /^\[ContextUsage\] received from cloud: CloudContextUsageEvent \{ items: (\[.*?\]), environment_context_used: (\S+?), rendered_file_rule_paths: (.+?) \}/,
  // 联网搜索的单页抓取明细（WebSearch 工具内部行为）。
  // 注意：这里的 token_count 是**网页内容**的 token 数，不是 LLM usage（早前误认过）。
  webFetch: /^\[RemoteFetchStrategy\] fetch_single completed: url=([^,]+), logid=([^,]+), elapsed=(\d+)ms, content_length=(\d+), token_count=(\S+?)[,\s]/,
  // 一次 WebSearch 调用的生命周期四件套。用它把并发的多次搜索拆开：
  // tool_entry（查询词）→ step1 完成（原始命中数）→ crawler targets（抓取目标清单）
  // → all steps completed（总耗时，可反推起点）。
  searchEntry: /^\[WebSearchDomainFilter\] stage=tool_entry query="(.*)" switch_allowed_domains=/,
  searchRefs: /^\[SearchService search_by_keywords\] step1 request_search_references completed: elapsed=(\d+)ms, references_count=(\d+)/,
  searchTargets: /^\[SearchService search_by_keywords\] step2 crawler targets: count=(\d+), urls=\[(.*)\]/,
  searchDone: /^\[SearchService search_by_keywords\] all steps completed: total_elapsed=(\d+)ms \(step1=(\d+)ms, step2=(\d+)ms\)/,
  // 采集器自身的开销：TRAE **同步阻塞**等 hook 进程返回，
  // 所以这段时间真实占用了用户感知到的时长，必须在轨迹里诚实交代。
  hookExec: /^\[Hooks\] ToolingHookCommandRunner (executing|finished) command="(\S+?)(?: ([A-Za-z]+))?"/,
  // 等用户确认的区间：register 开、route user decision 合，靠 confirmation_id 配对。
  // ⚠️ 这两行**不带 trace_id**（跑在 process_ipc_request:route 而非 chat 跨度上），
  // 所以只能靠 extra_route_ids 里的 call_xxx 对到具体工具，不能按 turn 收集。
  confirmRegister: /^\[PendingInteractionRegistry\] register confirmation_id=([^,]+), plan_item_id=(\S+?), toolcall_id=(\S+?), extra_route_ids=\[([^\]]*)\], session_id=(\S+?)[,\s]/,
  confirmDecision: /^\[PendingInteractionRegistry\] route user decision, confirmation_id=([^,]+),/,
  // 为何需要人工确认（实测 sandbox_execute_failure：命令被沙箱拦下）
  manualConfirm: /^\[need_manual_confirm\] toolcall_id is: ([^,]+), manual_confirm_reason is: ([^,]+),/,
};

function tsToMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * 解 Rust 的 `Option` debug 输出：`None` → null，`Some("x")` → `"x"`，`Some(123)` → 123。
 * TRAE 日志大量字段是这个形态，必须把 `None` 归成 null 而不是字符串 "None"，
 * 否则子智能体字段会看起来“有值”。
 */
function rustOpt(raw) {
  // 只剔尾逗号：不能预先剔掉 `)`，否则 `Some(500)` 会变成 `Some(500` 而匹配不上。
  const s = String(raw ?? '').trim().replace(/,+$/, '');
  if (!s || s === 'None') return null;
  const m = /^Some\((.*)\)$/.exec(s);
  const v = m ? m[1] : s;
  const unq = v.replace(/^"|"$/g, '');
  if (/^-?\d+$/.test(unq)) return Number(unq);
  if (unq === 'true') return true;
  if (unq === 'false') return false;
  return unq || null;
}

/**
 * 取最近一个还未收尾的搜索记录；传 url 时额外要求它的抓取目标清单包含该 url。
 *
 * 从后往前找：并发的多次搜索里，正在抓取的那次总是最晚开的那个。
 */
function findLastOpenSearch(list, url) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.closed) continue;
    if (url == null || r.urlSet.has(url)) return r;
  }
  return null;
}

/**
 * @param {string} logPath
 * @param {{sessionFilter?: string, maxTurns?: number}} opts
 */
export async function parseAgentLog(logPath, opts = {}) {
  const { sessionFilter } = opts;

  /** trace_id -> turn */
  const turns = new Map();
  /** 观察到的所有 session id */
  const sessions = new Set();
  /** trace_id -> session_id */
  const traceSession = new Map();
  /**
   * 等用户确认的区间。挂在这里而不是 turn 上：相关日志行不带 trace_id，
   * 只能先全局收集，再由 build-trace 靠 call_xxx 对到具体工具。
   */
  const confirmWaits = [];
  /** TRAE 内部 toolcall_id -> 需要人工确认的原因 */
  const confirmReasons = new Map();
  /**
   * MCP 服务器数量的观测点。单独放这里的原因：那行**不带 trace_id**
   * （跑在 process_ipc_request:route 而非 chat 跳跃上），只能先全局攒，
   * 再由 attachTurnLocalMcp 按时间落在哪一轮的窗口里归属。
   */
  const mcpCounts = [];
  const stats = { linesRead: 0, linesParsed: 0 };

  const ensureTurn = tid => {
    if (!turns.has(tid)) {
      turns.set(tid, {
        traceId: tid,
        sessionId: null,
        timings: [],       // {name, epochMs, delta}
        serverTimings: {}, // svr_* 字段
        tools: [],         // {name, status, costMs, endMs, spanPath}
        commands: [],      // {jobId, toolcallId, commandText, atMs}
        toolCallIds: [],   // {callId, name, atMs} LLM 侧 call_xxx，按出现次序
        toolStarts: [],    // {name, atMs} 工具真实起点，按出现次序
        llmRequests: [],   // {atMs, kind} 服务端推理请求，个数 = 真实 LLM 调用次数
        phases: [],        // {atMs, name} 相位标记，用于交代 span 之间的空白
        hookExecs: [],     // {event, beginMs, endMs} 采集器自身的阻塞开销
        agentRuns: [],     // {subagentType, agentCallId, parentAgentRunId, agentRunId, isAsync} create 请求侧谱系（实测恒为 None）
        subAgents: [],     // {agentRunId, agentId, parentToolCallId, createMs, finishMs} 真实委派出去的子智能体
        agentStatuses: [], // {agentRunId, status, runMode, atMs} 每次流式响应的归属与状态
        noNeedExecutes: [],// {toolName, callId, agentRunId, localExecution, atMs} 不在本地执行的工具（派发子智能体走这里）
        declaredSubAgents: new Set(), // 声明可用的子智能体成员名
        // Harness 装配结果：五大组件各自装了什么。只记本地真存在的证据，
        // 拿不到的（规则/记忆的**内容**、服务端拼的 system prompt）一律置 null。
        harness: {
          agentId: null,          // 主智能体声明 id（实测 solo_agent）
          rosterMembers: null,    // 声明的子智能体成员数
          rosterTotal: null,      // 装配后的名册总数（含主智能体）
          agentType: null,        // 技能查找时报的 agent_type
          configName: null,       // 技能查找时报的模型配置名
          mcpScanBeginMs: null,
          mcpScanEndMs: null,
          mcpServerCount: null,   // 按时间窗口归属（那行不带 trace_id）
          rules: null,            // {globalCount, projectTypes[], shouldMask, maxChars, totalChars}
          skills: new Map(),      // name -> {name, state, source, path}
          skillsRemoved: [],      // {name, reason} 被门控裁掉的
          memory: null,           // {chatMemory, coreMemory}
          contextUsages: [],      // {atMs, environmentUsed, fileRulePaths} 云端异步回执
          beginMs: null,
          endMs: null,
        },
        webFetches: [],    // {url, elapsedMs, contentLength, tokenCount, atMs} 联网搜索抓取明细（全轮次汇总）
        webSearches: [],   // 按「一次 WebSearch 调用」聚合的记录，见 RE.searchEntry 一族
        _searchQueries: [], // 待配对的 tool_entry 查询词（搜索并发时不能按顺序配）
        _lastRefs: null,   // 紧邻 crawler targets 之前的 step1 命中数
        modelParams: {},   // 客户端侧的 LLM 请求参数
        commits: [],       // ReAct 迭代边界：每次提交工具结果的时刻（epoch ms）
        toolResults: [],   // {toolcallId, name, result} 从 commit 载荷里提取
        model: {},
        agentType: null,
        firstMs: null,
        lastMs: null,
        spanPaths: new Set(),
      });
    }
    return turns.get(tid);
  };

  const stream = fs.createReadStream(logPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // 记录最近一次出现的 RunCommand 上下文，用于把 job/命令文本挂到 turn 上
  let lastCmdText = null;

  for await (const line of rl) {
    stats.linesRead++;

    let hinted = false;
    for (const h of KEEP_HINTS) {
      if (line.includes(h)) {
        hinted = true;
        break;
      }
    }
    if (!hinted) continue;

    const head = RE.head.exec(line);
    const atMs = head ? tsToMs(head[1]) : null;
    const spanPath = head ? head[3] || '' : '';
    // 消息体 = 去掉时间戳 / 级别 / span 路径 / 模块路径之后的部分。
    // 所有锚定 `^` 的规则都只对它匹配，见 PHASE_MARKERS 上的说明。
    const msg = head ? line.slice(head[0].length).trimStart() : line;

    // trace_id 取**最后一个**匹配：tracing 字段追加在行尾，而 payload 回灌的
    // 文件内容在中间，取第一个会被伪造的 trace_id 顶掉。
    let tid = null;
    for (const m of line.matchAll(RE.traceIdAll)) tid = m[1];

    // ---- timing 增量事件 ----
    const ta = RE.timingAdd.exec(line);
    if (ta) {
      const [, traceId, kind, name, epoch, delta] = ta;
      const turn = ensureTurn(traceId);
      turn.kind = kind;
      turn.timings.push({ name, epochMs: Number(epoch), delta: Number(delta) });
      if (spanPath) turn.spanPaths.add(spanPath);
      stats.linesParsed++;
      continue;
    }

    // ---- timing 汇总（含服务端 svr_*）----
    const tf = RE.timingFinal.exec(msg);
    if (tf) {
      const [, traceId, , jsonPart] = tf;
      const turn = ensureTurn(traceId);
      const obj = tryParseLeadingJson(jsonPart);
      if (obj) {
        for (const [k, v] of Object.entries(obj)) {
          if (k.startsWith('svr')) turn.serverTimings[k] = v;
        }
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 工具调用 ----
    // ---- 工具真实起点（必须在 RE.tool 之前判：两者前缀相同，但 Start 行没有 cost 字段）----
    const ts = RE.toolStart.exec(msg);
    if (ts && tid) {
      ensureTurn(tid).toolStarts.push({ name: ts[1], atMs });
      stats.linesParsed++;
      continue;
    }

    const tm = RE.tool.exec(msg);
    if (tm && tid) {
      const [, name, outcome, status, cost] = tm;
      const turn = ensureTurn(tid);
      turn.tools.push({
        name,
        outcome,
        status,
        costMs: Number(cost),
        endMs: atMs,
        spanPath,
      });
      if (spanPath) turn.spanPaths.add(spanPath);
      stats.linesParsed++;
      continue;
    }

    // ---- 服务端推理请求（迭代数的权威依据）----
    const lr = RE.llmRequest.exec(msg);
    if (lr && tid) {
      const turn = ensureTurn(tid);
      turn.llmRequests.push({ atMs, kind: lr[1] });
      stats.linesParsed++;
      continue;
    }

    // ---- 采集器自身开销（hook 进程）----
    // 它们是真实的区间（有起有讫），而不是单一时刻：实测单次 500~800ms、
    // 一轮触发 17~21 次，占整轮壁钟 17%~30%。不记下来的话，这些时间在轨迹上
    // 会表现为工具之间“无交代的空白”，等于把观测者自身的成本藏起来。
    const he = RE.hookExec.exec(msg);
    if (he && tid) {
      const turn = ensureTurn(tid);
      const event = he[3] || 'unknown';
      if (he[1] === 'executing') {
        turn.hookExecs.push({ event, beginMs: atMs, endMs: null });
      } else {
        // 同步执行，所以最近一个未闭合的就是它的开头
        const open = [...turn.hookExecs].reverse().find(x => x.endMs == null && x.event === event);
        if (open) open.endMs = atMs;
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 相位标记（只记时刻，用于解释叶子 span 之间的空白）----
    // 放在其他分支之后，不用 continue：同一行可能既是相位标记也携带其他信息
    if (tid) {
      for (const [re, label] of PHASE_MARKERS) {
        const pm = re.exec(msg);
        if (pm) {
          ensureTurn(tid).phases.push({ atMs, name: label(pm) });
          stats.linesParsed++;
          break;
        }
      }
    }

    // ---- LLM 侧 tool call id（与 hook 的 tool_use_id 同值）----
    // 注意它与 `Run tool X finished` 的先后顺序不固定：实测 LS 是 execute 在前，
    // RunCommand 是 finished 在前（异步下发）。所以只按出现次序收集，
    // 由 build-trace 按「同名工具的第 k 次」与工具 span 配对，不依赖相对位置。
    const et = RE.execToolcall.exec(msg);
    if (et && tid) {
      const callId = et[1].trim();
      if (callId) {
        const turn = ensureTurn(tid);
        turn.toolCallIds.push({ callId, name: et[2].trim(), agentRunId: (et[3] || '').trim() || null, atMs });
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 等用户确认：区间开头 ----
    // 这段时间是**人在想**，不是 Agent 在干活。不记下来的话，轨迹上它表现为
    // 工具之间一段无交代的长空白（实测 18 秒），容易被当成采集遗漏或 Agent 卡顿。
    const cr = RE.confirmRegister.exec(msg);
    if (cr) {
      confirmWaits.push({
        confirmationId: cr[1].trim(),
        planItemId: rustOpt(cr[2]),
        toolcallId: rustOpt(cr[3]),
        // extra_route_ids 里是 LLM 侧的 call_xxx，是对到工具 span 的唯一可靠键
        callIds: [...cr[4].matchAll(/"([^"]+)"/g)].map(m => m[1]),
        sessionId: rustOpt(cr[5]),
        beginMs: atMs,
        endMs: null,
      });
      stats.linesParsed++;
      continue;
    }

    // ---- 等用户确认：区间收尾 ----
    const cd = RE.confirmDecision.exec(msg);
    if (cd) {
      const id = cd[1].trim();
      const open = [...confirmWaits].reverse().find(w => w.endMs == null && w.confirmationId === id);
      if (open) open.endMs = atMs;
      stats.linesParsed++;
      continue;
    }

    // ---- 需要人工确认的原因 ----
    const mcf = RE.manualConfirm.exec(msg);
    if (mcf) {
      confirmReasons.set(mcf[1].trim(), mcf[2].trim());
      stats.linesParsed++;
      continue;
    }

    // ---- 子智能体谱系（create 请求侧，实测恒为 None，仅用于把「没委派」与「采不到」分开）----
    const ari = RE.agentRunInfo.exec(msg);
    if (ari && tid) {
      const turn = ensureTurn(tid);
      turn.agentRuns.push({
        subagentType: rustOpt(ari[1]),
        taskId: rustOpt(ari[2]),
        isAsync: rustOpt(ari[3]),
        agentCallId: rustOpt(ari[4]),
        parentAgentRunId: rustOpt(ari[5]),
        agentRunId: rustOpt(ari[6]),
        atMs,
      });
      stats.linesParsed++;
      continue;
    }

    // ---- 真实委派出去的子智能体：Create 开括号 ----
    const sac = RE.subAgentCreate.exec(msg);
    if (sac && tid) {
      const turn = ensureTurn(tid);
      // Create 只给 agent_run_id，类型与父工具调用要等 Finish 才知道
      turn.subAgents.push({
        agentRunId: sac[1],
        agentId: null,
        parentToolCallId: null,
        createMs: atMs,
        finishMs: null,
        status: null,
      });
      stats.linesParsed++;
      continue;
    }

    // ---- 真实委派出去的子智能体：Finish 合括号（同时补齐类型与父工具调用）----
    const saf = RE.subAgentFinish.exec(msg);
    if (saf && tid) {
      const turn = ensureTurn(tid);
      const runId = saf[1];
      let rec = turn.subAgents.find(s => s.agentRunId === runId && s.finishMs == null);
      if (!rec) {
        // 没见到 Create（日志被轮转截断）也要收下，否则整段委派会凭空消失
        rec = { agentRunId: runId, agentId: null, parentToolCallId: null, createMs: null, finishMs: null, status: null };
        turn.subAgents.push(rec);
      }
      rec.agentId = saf[2].trim();
      rec.parentToolCallId = saf[3].trim();
      rec.finishMs = atMs;
      stats.linesParsed++;
      continue;
    }

    // ---- 每次流式响应的归属与状态 ----
    const ast = RE.agentStatus.exec(msg);
    if (ast && tid) {
      const turn = ensureTurn(tid);
      turn.agentStatuses.push({ agentRunId: ast[1], status: ast[2], runMode: ast[3] || null, atMs });
      // 子智能体收尾状态回填到它的生命周期记录上
      const sub = turn.subAgents.find(s => s.agentRunId === ast[1]);
      if (sub) sub.status = ast[2];
      stats.linesParsed++;
      continue;
    }

    // ---- 不在本地执行的工具：派发子智能体的真名只有这里有 ----
    const nne = RE.sseNoNeedExecute.exec(msg);
    if (nne && tid) {
      const turn = ensureTurn(tid);
      const callId = nne[2].trim();
      // 同一个 toolcall 会被 SSE 反复路由（实测 7 次），只留第一次
      if (!turn.noNeedExecutes.some(x => x.callId === callId)) {
        turn.noNeedExecutes.push({
          toolName: nne[1].trim(),
          callId,
          agentRunId: nne[3].trim(),
          localExecution: nne[4] === 'true',
          atMs,
        });
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 声明侧：可调用的子智能体成员 ----
    const cas = RE.customAgentSub.exec(msg);
    if (cas && tid) {
      ensureTurn(tid).declaredSubAgents.add(cas[1].trim());
      stats.linesParsed++;
      continue;
    }

    // ---- Harness 装配相位 ----
    // 每条都把时间戳往 harness 的 begin/end 上攒，拉出装配窗口。
    // 只括到记忆开关为止：云端回执（contextUsage）是异步的，把它拉进来
    // 会把 22ms 的装配拉成 90 秒，那就不是装配窗口而是整轮了。
    const markHarness = (turn, ms) => {
      const h = turn.harness;
      if (ms == null) return h;
      if (h.beginMs == null || ms < h.beginMs) h.beginMs = ms;
      if (h.endMs == null || ms > h.endMs) h.endMs = ms;
      return h;
    };

    const hb = RE.harnessBegin.exec(msg);
    if (hb && tid) {
      markHarness(ensureTurn(tid), atMs).agentId = hb[1].trim().replace(/,$/, '');
      stats.linesParsed++;
      continue;
    }

    const ram = RE.rootAgentMembers.exec(msg);
    if (ram && tid) {
      markHarness(ensureTurn(tid), atMs).rosterMembers = Number(ram[1]);
      stats.linesParsed++;
      continue;
    }

    const alb = RE.agentListBuilt.exec(msg);
    if (alb && tid) {
      markHarness(ensureTurn(tid), atMs).rosterTotal = Number(alb[1]);
      stats.linesParsed++;
      continue;
    }

    const msb = RE.mcpScanBegin.exec(msg);
    if (msb && tid) {
      markHarness(ensureTurn(tid), atMs).mcpScanBeginMs = atMs;
      stats.linesParsed++;
      continue;
    }

    const mse = RE.mcpScanEnd.exec(msg);
    if (mse && tid) {
      markHarness(ensureTurn(tid), atMs).mcpScanEndMs = atMs;
      stats.linesParsed++;
      continue;
    }

    // MCP 服务器数量：这行没有 trace_id，先全局攒着，最后按时间窗口归属。
    const mcc = RE.mcpCount.exec(msg);
    if (mcc) {
      mcpCounts.push({ atMs, count: Number(mcc[1]) });
      stats.linesParsed++;
      continue;
    }

    const rr = RE.rawRules.exec(msg);
    if (rr && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      // project_rules_types 是个 Rust Vec 的 debug 输出，实测为空。
      // 空字符串 split 会得到 ['']，得先判空，否则 0 条规则会看起来像 1 条。
      const types = rr[2].trim() ? rr[2].split(',').map(s => s.trim()).filter(Boolean) : [];
      h.rules = { ...(h.rules || {}), globalCount: Number(rr[1]), projectTypes: types, shouldMask: rr[3] === 'true' };
      stats.linesParsed++;
      continue;
    }

    const rrc = RE.rawRulesChars.exec(msg);
    if (rrc && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      h.rules = { ...(h.rules || {}), maxChars: Number(rrc[3]), totalChars: Number(rrc[4]) };
      stats.linesParsed++;
      continue;
    }

    // 技能引擎：同一个技能会连出多行（looking → not found → fallback/found），
    // 后写覆盖前写，所以 Map 天然就是「以最后一条结论为准」。
    const sl = RE.skillLookup.exec(msg);
    if (sl && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      h.agentType = sl[2].trim();
      h.configName = sl[3].trim().replace(/,$/, '');
      // 先落个 unresolved：如果后续没有任何落地行，它就该停在 unresolved，
      // 不能因为“没看到失败行”就默认当成功。
      if (!h.skills.has(sl[1])) h.skills.set(sl[1], { name: sl[1], state: 'unresolved', source: null, path: null });
      stats.linesParsed++;
      continue;
    }

    const sf = RE.skillFound.exec(msg);
    if (sf && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      // 'global' 这一支指的是用户自己的 ~/.agents/skills/，
      // 与内置的 ~/.trae-cn/builtin/global/skills/ 不是一回事，必须分开标。
      const source = sf[1] === 'global' ? 'user_global' : 'local_builtin';
      h.skills.set(sf[2], { name: sf[2], state: 'loaded', source, path: sf[3] });
      stats.linesParsed++;
      continue;
    }

    const sfb = RE.skillFallback.exec(msg);
    if (sfb && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      h.skills.set(sfb[2], { name: sfb[2], state: 'loaded', source: 'builtin_global', path: sfb[1] });
      stats.linesParsed++;
      continue;
    }

    const srm = RE.skillRemoved.exec(msg);
    if (srm && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      const name = srm[1].trim();
      if (!h.skillsRemoved.some(x => x.name === name)) {
        h.skillsRemoved.push({ name, reason: (srm[2] || '').trim() || null });
      }
      h.skills.delete(name);
      stats.linesParsed++;
      continue;
    }

    const mem = RE.memoryConfig.exec(msg);
    if (mem && tid) {
      const h = markHarness(ensureTurn(tid), atMs);
      h.memory = { chatMemory: rustOpt(mem[1]), coreMemory: mem[2] === 'true' };
      stats.linesParsed++;
      continue;
    }

    // 云端回执：**不**参与装配窗口的计算（它可能落在推理中途）
    const cu = RE.contextUsage.exec(msg);
    if (cu && tid) {
      ensureTurn(tid).harness.contextUsages.push({
        atMs,
        items: cu[1],
        environmentUsed: rustOpt(cu[2]),
        fileRulePaths: rustOpt(cu[3]),
      });
      stats.linesParsed++;
      continue;
    }

    // ---- 联网搜索：查询词入口 ----
    const se = RE.searchEntry.exec(msg);
    if (se && tid) {
      // 这是 LLM 真实下发的搜索参数，在无 hook 的历史日志里是唯一来源。
      ensureTurn(tid)._searchQueries.push({ atMs, query: se[1] });
      stats.linesParsed++;
      continue;
    }

    // ---- 联网搜索：step1 原始命中数 ----
    // 它与 crawler targets 的差值能区分「搜索本身无结果」和「域名过滤全筛掉了」。
    const sr = RE.searchRefs.exec(msg);
    if (sr && tid) {
      ensureTurn(tid)._lastRefs = { atMs, elapsedMs: Number(sr[1]), count: Number(sr[2]) };
      stats.linesParsed++;
      continue;
    }

    // ---- 联网搜索：抓取目标清单（一次调用的开括号）----
    const st = RE.searchTargets.exec(msg);
    if (st && tid) {
      const turn = ensureTurn(tid);
      const urls = [...st[2].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      // step1 与 crawler targets 实测同一毫秒内相邻，隔得远就不是同一次搜索的
      const refs = turn._lastRefs && atMs - turn._lastRefs.atMs <= 50 ? turn._lastRefs : null;
      turn.webSearches.push({
        targetCount: Number(st[1]),
        urls,
        urlSet: new Set(urls),
        referencesCount: refs ? refs.count : null,
        searchApiMs: refs ? refs.elapsedMs : null,
        fetches: [],
        openAtMs: atMs,
        closed: false,
      });
      turn._lastRefs = null;
      stats.linesParsed++;
      continue;
    }

    // ---- 联网搜索：收尾（一次调用的闭括号）----
    const sd = RE.searchDone.exec(msg);
    if (sd && tid) {
      const turn = ensureTurn(tid);
      const rec = findLastOpenSearch(turn.webSearches);
      if (rec) {
        rec.closed = true;
        rec.doneAtMs = atMs;
        rec.totalElapsedMs = Number(sd[1]);
        rec.step1Ms = Number(sd[2]);
        rec.step2Ms = Number(sd[3]);
        // 用 total_elapsed 反推起点，再据此对号 tool_entry 里的查询词。
        // 实测两者严格相等（误差 0~1ms），比按出现次序配稳：
        // 多次搜索并发时，启动顺序与完成顺序不一致。
        rec.startMs = atMs - rec.totalElapsedMs;
        const hit = turn._searchQueries
          .filter(q => !q.used)
          .sort((a, b) => Math.abs(a.atMs - rec.startMs) - Math.abs(b.atMs - rec.startMs))[0];
        if (hit && Math.abs(hit.atMs - rec.startMs) <= 50) {
          rec.query = hit.query;
          hit.used = true;
        }
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 联网搜索：逐页抓取明细 ----
    const wf = RE.webFetch.exec(msg);
    if (wf && tid) {
      const turn = ensureTurn(tid);
      const f = {
        url: wf[1],
        elapsedMs: Number(wf[3]),
        contentLength: Number(wf[4]),
        tokenCount: rustOpt(wf[5]),
        atMs,
      };
      turn.webFetches.push(f);
      // 归属按 **URL 对号**：落到“还未收尾、且抓取目标清单含这个 URL”的那次搜索。
      // 不能按时间窗：实测一次推理会并发下发多个 WebSearch，窗口互相重叠，
      // 曾把前一次搜索的 5 页算到后一次头上（报成 10 页）。
      const owner = findLastOpenSearch(turn.webSearches, f.url) || findLastOpenSearch(turn.webSearches);
      if (owner) {
        owner.fetches.push(f);
        if (!owner.urlSet.has(f.url)) owner.unmatchedFetch = true;
      } else {
        f.orphan = true;
      }
      stats.linesParsed++;
      continue;
    }

    // ---- 客户端侧 LLM 请求参数 ----
    const mc = RE.modelConfig.exec(msg);
    if (mc && tid) {
      const turn = ensureTurn(tid);
      turn.modelParams = {
        configName: mc[1],
        modelName: mc[2],
        maxTurn: rustOpt(mc[3]),
        promptMaxTokens: rustOpt(mc[4]),
        maxTokens: rustOpt(mc[5]),
        // extra_config 里两个影响 LLM 行为的开关，对理解轨迹有用：
        // native_function_call 决定工具调用是否走原生 function call；
        // pass_back_reasoning 决定思考过程是否回传给下一轮。
        nativeFunctionCall: /"native_function_call": Bool\(true\)/.test(msg),
        passBackReasoning: /"pass_back_reasoning": Bool\(true\)/.test(msg),
      };
      stats.linesParsed++;
      continue;
    }

    // ---- ReAct 迭代边界：提交工具结果给服务端 ----
    // 同时从载荷里抽取 toolcall_resp —— 这是非 RunCommand 工具结果在本地的**唯一**来源，
    // 早前认为「日志中无工具结果」是错的：当时搜的是 result/output/stdout 等关键词，没想到字段名叫 toolcall_resp。
    if (RE.commitResult.test(msg) && tid) {
      const turn = ensureTurn(tid);
      turn.commits.push(atMs);
      // 一次提交可能含多个工具结果，逐个抽
      const re = new RegExp(RE.toolcallResp.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const [, toolcallId, name] = m;
        // 结果正文从匹配尾部开始，手工扫到未转义的结束引号
        const result = readJsonString(line, m.index + m[0].length);
        turn.toolResults.push({ toolcallId, name, result, atMs });
      }
      stats.linesParsed++;
      continue;
    }

    // ---- RunCommand 命令原文（在 completed 之前出现）----
    const rc = RE.runCmdText.exec(msg);
    if (rc) {
      lastCmdText = { text: rc[1], atMs };
      continue;
    }

    // ---- RunCommand 完成，拿到 job id ----
    const cc = RE.cmdCompleted.exec(msg);
    if (cc && tid) {
      const turn = ensureTurn(tid);
      turn.commands.push({
        jobId: cc[1],
        commandText: lastCmdText ? lastCmdText.text : null,
        atMs,
      });
      stats.linesParsed++;
      continue;
    }

    // ---- toolcall_id 收尾 ----
    const cf = RE.cmdFinish.exec(msg);
    if (cf && tid) {
      const turn = ensureTurn(tid);
      const last = turn.commands[turn.commands.length - 1];
      if (last && !last.toolcallId) last.toolcallId = cf[1];
      continue;
    }

    // ---- 模型信息（注意日志里同行含明文 ak，这里只取白名单字段）----
    if (line.includes('model_info: CustomModel') && tid) {
      const turn = ensureTurn(tid);
      const mn = RE.modelName.exec(line);
      const dm = RE.displayModel.exec(line);
      const pv = RE.provider.exec(line);
      if (mn) turn.model.requestModel = mn[1];
      if (dm) turn.model.responseModel = dm[1];
      if (pv) turn.model.provider = pv[1];
      stats.linesParsed++;
    }

    // ---- session 绑定 ----
    const sm = RE.sessionId.exec(line);
    if (sm) {
      sessions.add(sm[1]);
      if (tid && !traceSession.has(tid)) traceSession.set(tid, sm[1]);
    }

    const am = RE.agentType.exec(line);
    if (am && tid) ensureTurn(tid).agentType = am[1];

    // 维护 turn 时间范围
    if (tid && atMs != null) {
      const turn = ensureTurn(tid);
      if (turn.firstMs == null || atMs < turn.firstMs) turn.firstMs = atMs;
      if (turn.lastMs == null || atMs > turn.lastMs) turn.lastMs = atMs;
      if (spanPath) turn.spanPaths.add(spanPath);
    }
  }

  // 回填 session 归属
  for (const [tid, turn] of turns) {
    turn.sessionId = traceSession.get(tid) || null;
  }

  // 只保留“真实对话轮次”：必须有 chat 起始时间点
  let result = [...turns.values()].filter(t =>
    t.timings.some(x => x.name === 'rs_01_chat_begin'),
  );

  let sessionMatch = 'n/a';
  if (sessionFilter) {
    const bound = result.filter(t => t.sessionId === sessionFilter);
    if (bound.length > 0) {
      result = bound;
      sessionMatch = 'exact';
    } else if (result.every(t => t.sessionId == null)) {
      // 整份日志都没绑定到任何 session（单 session 日志，或 session_id
      // 字段未随行输出）—— 此时宽松纳入是合理的，但得标出来。
      sessionMatch = 'unbound';
    } else {
      // 日志里确实有其他 session，但没有要找的这个。
      // 必须返回空而不能退回“全都要”：否则别的 session 的轨迹会被
      // 贴上请求的 session 标签返回，等于凭空造假。实测踩过：请求另一个
      // TRAE 窗口（另一份日志目录）的 session，拿回了 12 轮不相关的数据。
      result = [];
      sessionMatch = 'absent';
    }
  }

  result.sort((a, b) => beginOf(a) - beginOf(b));
  for (const t of result) {
    // Set 在这里统一转数组：下游要把它们当 span 属性序列化，Set 会变成 {}
    t.spanPaths = [...t.spanPaths];
    t.declaredSubAgents = [...t.declaredSubAgents];
    // 技能同理：Map 序列化也是 {}。排序固定下来，否则两轮的技能清单
    // 只是顺序不同就会看起来像不一样。
    t.harness.skills = [...t.harness.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
    attachTurnLocalMcp(t, mcpCounts);
  }

  // 确认等待：补上原因，只保留已收尾的（未收尾 = 日志写到一半，算不出时长），
  // 并按 session 收窄（这些行没有 trace_id，但带 session_id）。
  const waits = confirmWaits
    .filter(w => w.endMs != null && (!sessionFilter || w.sessionId === sessionFilter))
    .map(w => ({ ...w, reason: confirmReasons.get(w.toolcallId) || null }));

  return { turns: result, sessions: [...sessions], stats, sessionMatch, confirmWaits: waits };
}

export function beginOf(turn) {
  const b = turn.timings.find(x => x.name === 'rs_01_chat_begin');
  return b ? b.epochMs : turn.firstMs || 0;
}

/**
 * 把 MCP 服务器数量归到本轮。
 *
 * 那行日志不带 trace_id，所以只能靠时间归属——而时间归属是靠不住的
 * 那类做法，所以这里把规则卡死，宁可置 null 也不猜：
 *
 *  1. 只接受落在【本轮自己的窗口】内的观测点。窗口上界取装配结束时刻：
 *     实测 MCP 那行比 `before read_all_mcp_servers` 还早 ~37ms（读缓存），
 *     所以不能用扫描区间卡，得用整个前导窗口。
 *  2. 窗口内恰好一个才采用。多于一个就是歧义（并发轮次时会发生），
 *     宁可置 null 并标出 ambiguous，也不能拿“最近的那个”蒙。
 */
function attachTurnLocalMcp(turn, mcpCounts) {
  const h = turn.harness;
  const lo = beginOf(turn);
  const hi = h.endMs;
  if (!lo || !hi) return;
  const inWindow = mcpCounts.filter(x => x.atMs != null && x.atMs >= lo && x.atMs <= hi);
  if (inWindow.length === 1) {
    h.mcpServerCount = inWindow[0].count;
  } else if (inWindow.length > 1) {
    h.mcpServerCount = null;
    h.mcpCountAmbiguous = inWindow.length;
  }
}

/** 单条工具结果的保留上限：Shell 输出实测可达 32KB+，demo 只需看到有内容与前缀 */
const MAX_RESULT_CHARS = 8000;

function truncate(text) {
  if (typeof text !== 'string' || text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}…[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
}

/**
 * 从 pos 起读出一个 JSON 字符串字面量并反转义（toolcall_resp 实测恒为字符串）。
 *
 * 不能整行 JSON.parse：行首有 tracing 前缀，过长行还可能被截断，
 * 所以手工扫到第一个未转义的结束引号为止。
 */
function readJsonString(line, pos) {
  let i = pos;
  while (i < line.length && line[i] !== '"') i++;
  if (i >= line.length) return null;

  const start = i;
  i++;
  let esc = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      const literal = line.slice(start, i + 1);
      try {
        return truncate(JSON.parse(literal));
      } catch {
        // 转义序列异常时退回原文，不因单条结果丢掉整行
        return truncate(line.slice(start + 1, i));
      }
    }
  }
  // 结束引号没出现 = 日志行被截断，把已读到的部分交出去
  return truncate(line.slice(start + 1));
}

/** 日志行里的 JSON 可能被后续文本粘连，逐字符配平括号取出前缀 JSON */
function tryParseLeadingJson(s) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
