/**
 * 合成 OTel 风格 span 树
 *
 * 落地 docs/zh-CN/trae-session-trace-path.md 的方案：
 *   trace_id 直接复用 TRAE 的 32 位 hex
 *   ENTRY → AGENT → STEP(一次 ReAct 迭代) → { LLM, TOOL... }
 *
 * 层级按仓库既有约定（scripts/validate-trace.mjs 强制）：
 *   STEP 的父必须是 AGENT，LLM / TOOL 的父必须是 STEP，且每个 STEP 恰好 1 个 LLM。
 *   即轨迹是「推理 → 该次推理下发的工具 → 再推理 → …」的迭代序列，
 *   不是把所有 STEP 排一排、再把所有 TOOL 排一排。
 *
 * 迭代边界取自 `[commit_toolcall_result] endpoint=`【实测】：提交工具结果即当前迭代结束、
 * 服务端开始生成下一步。轮次准备阶段（上下文收集 / prompt 渲染）没有推理，
 * 按上述约定不能当 STEP，改为 AGENT span 上的 span event。
 *
 * span_id 由本地合成（TRAE 日志只有 span 名，没有 span_id）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentLog, beginOf } from './parse-agent-log.mjs';
import { readAgentIdentity } from './read-agent-identity.mjs';
import { parseToolhostLog, readJobArtifacts } from './parse-toolhost.mjs';
import { loadHookEvents, indexHookEvents } from './parse-hook-events.mjs';
import {
  findLatestLogSession,
  findLogSessionsMentioning,
  findToolhostLog,
  findJobsDir,
  DEFAULT_SESSION_ID,
  PILOT_DATA_DIR,
} from './config.mjs';

let spanSeq = 0;
function newSpanId() {
  // 16 hex = 8 bytes，符合 OTel span_id 格式
  spanSeq++;
  return crypto.createHash('sha1').update(`span-${process.pid}-${spanSeq}`).digest('hex').slice(0, 16);
}

const RESOLVER_EVENTS = [
  'rs_06_resolver_user_message',
  'rs_06_resolver_terminal',
  'rs_06_resolver_websearch',
  'rs_06_resolver_browser_selection',
  'rs_06_resolver_log_message',
];

/**
 * 轮次生命周期事件：[rs_* 名, 轨迹里的事件名]。
 * 这些都发生在首次 LLM 请求之前（或轮次收尾），不属于任何 ReAct 迭代，
 * 但它们占据的真实壁钟时间必须在轨迹里有交代。
 * 注意 rs_NN 的编号不代表先后（实测 rs_05 最后触发），排序统一靠 atMs。
 */
const LIFECYCLE_EVENTS = [
  ['rs_01_chat_begin', 'turn.begin'],
  ['rs_02_get_session', 'session.load'],
  ['rs_03_get_history_message', 'history.load'],
  ['rs_04_create_message', 'message.create'],
  ['rs_06_get_custom_model', 'model.resolve'],
  ['rs_07_create_task', 'task.create'],
  ['rs_08_create_turn', 'turn.create'],
  ['rs_09_process_task', 'task.process.begin'],
  ['rs_15_before_generate_plan', 'plan.generate.begin'],
  ['rs_05_create_snapshot', 'snapshot.create'],
];

/**
 * TRAE 内部工具：日志里会出现但**不触发任何 hook**（实测：同一轮里 `finish` 在
 * `[ToolcallService] Run tool` 有记录，而 PreToolUse / PostToolUse 一条都没有）。
 * 它们也不在官方标准工具名列表里。没有结果属于预期，不是采集缺口。
 */
const INTERNAL_TOOLS = new Set(['finish']);

/** 工具状态统一成小写：日志给 `Success`，hook 给 `success`，不归一会让下游按值聚合时分成两类 */
function normalizeToolStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return undefined;
  if (s === 'failed' || s === 'failure') return 'error';
  return s;
}

/** commit 载荷里的工具结果与工具完成时刻的容差（提交紧随完成，但异步工具会滞后） */
const RESULT_MATCH_TOLERANCE_MS = 2000;

/**
 * WebSearch 工具 span 与 SearchService 搜索记录对号的容差。
 * 实测两边的耗时与收尾时刻只差 0~2ms，取 50ms 既宽松又远小于
 * 并发搜索之间的间隔（实测最小 447ms），不会串位。
 */
const SEARCH_COST_TOLERANCE_MS = 50;

function pick(turn, name) {
  const hit = turn.timings.find(t => t.name === name);
  return hit ? hit.epochMs : null;
}

/**
 * 取同名 timing 的全部时刻。
 * 一轮内多次 ReAct 迭代会重复触发同一事件（实测单轮 rs_16 出现 7 次），
 * 只 find() 第一条会把 7 次推理压成 1 个 LLM span。
 */
function pickAll(turn, name) {
  return turn.timings.filter(t => t.name === name).map(t => t.epochMs).sort((a, b) => a - b);
}

/** 严格按 epoch ms 排序取末尾 —— 不能依赖 rs_NN 编号（rs_05 实测最后触发） */
function lastTimingMs(turn) {
  if (turn.timings.length === 0) return null;
  return turn.timings.reduce((m, t) => Math.max(m, t.epochMs), 0);
}

function span(kind, name, startMs, endMs, attrs = {}, children = []) {
  const s = Math.max(0, Number(startMs) || 0);
  let e = Number(endMs);
  if (!Number.isFinite(e) || e < s) e = s;
  return {
    spanId: newSpanId(),
    kind,
    name,
    startMs: s,
    endMs: e,
    durationMs: e - s,
    attributes: attrs,
    children,
    // 状态从子节点上卷：任一后代失败则整条链置 ERROR。
    // 不给 ENTRY / AGENT / LLM 留空（前端会显示成 "-"，看不出成败），
    // 也不无条件写 OK（会把失败轮次粉饰成正常）。构造后可被调用方显式覆盖。
    status: children.some(c => c.status === 'ERROR') ? 'ERROR' : 'OK',
  };
}

function flattenSpans(root, out = []) {
  out.push(root);
  for (const child of root.children || []) flattenSpans(child, out);
  return out;
}

function loadModelCaptures(limit = 500) {
  const dir = path.join(PILOT_DATA_DIR, 'logs', 'trae-cn', 'model-capture');
  try {
    if (!fs.existsSync(dir)) return [];
    const rows = [];
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const p = path.join(dir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime)
      .slice(-5);
    for (const file of files) {
      for (const line of fs.readFileSync(file.p, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  }
}

function enrichTracesWithModelCapture(traces, captures) {
  const pairs = [];
  const pending = [];
  for (const row of captures) {
    if (row.kind === 'llm.request.capture') {
      pending.push({ id: row.id, request: row, response: null });
      continue;
    }
    if (row.kind !== 'llm.response.capture') continue;
    let idx = -1;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].id === row.id && !pending[i].response) { idx = i; break; }
    }
    const pair = idx >= 0 ? pending.splice(idx, 1)[0] : { id: row.id, request: null, response: null };
    pair.response = row;
    pairs.push(pair);
  }
  for (const pair of pending) pairs.push(pair);
  const orderedPairs = pairs
    .filter(x => x.request || x.response)
    .map(x => ({
      request: x.request,
      response: x.response,
      atMs: Date.parse(x.request?.ts || x.response?.ts || ''),
    }))
    .filter(x => Number.isFinite(x.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  if (orderedPairs.length === 0) return { count: 0, matched: 0 };

  let matched = 0;
  const used = new Set();
  for (const trace of traces) {
    const llms = flattenSpans(trace.root).filter(s => s.kind === 'LLM').sort((a, b) => a.startMs - b.startMs);
    for (const llm of llms) {
      let best = null;
      let bestDistance = Infinity;
      for (let i = 0; i < orderedPairs.length; i++) {
        if (used.has(i)) continue;
        const p = orderedPairs[i];
        const distance = p.atMs < llm.startMs
          ? llm.startMs - p.atMs
          : (p.atMs > llm.endMs ? p.atMs - llm.endMs : 0);
        // demo 容忍 5 分钟窗口：TRAE 日志与本地代理都是本机 wall clock，正常应接近重合。
        if (distance > 5 * 60 * 1000 || distance >= bestDistance) continue;
        best = { pair: p, index: i };
        bestDistance = distance;
      }
      if (!best) continue;
      used.add(best.index);
      matched++;
      const req = best.pair.request || {};
      const resp = best.pair.response || {};
      const a = llm.attributes || {};
      if (a['gen_ai.request.model']) a['trae.model.log_request_model'] = a['gen_ai.request.model'];
      if (a['gen_ai.response.model']) a['trae.model.log_response_model'] = a['gen_ai.response.model'];
      if (req.model) {
        a['gen_ai.request.model'] = req.model;
        a['gen_ai.response.model'] = req.model;
        a['gen_ai.provider.name'] = req.model.includes('qwen') ? 'qwen' : a['gen_ai.provider.name'];
        a['trae.model.source'] = 'custom_model_proxy';
        llm.name = `chat ${req.model}`;
      }
      const requestBody = req.body && typeof req.body === 'object' ? req.body : null;
      if (Array.isArray(requestBody?.messages)) {
        a['gen_ai.input.messages'] = requestBody.messages;
        a['trae.input.provenance'] = 'custom_model_proxy:request.body.messages（完整请求体）';
        a['trae.input.complete'] = true;
        delete a['trae.input.missing'];
      }
      if (Array.isArray(requestBody?.tools)) {
        a['gen_ai.tool.definitions'] = requestBody.tools;
        a['trae.model_proxy.tools_count'] = requestBody.tools.length;
      }
      for (const key of ['tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stream', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
        if (requestBody?.[key] !== undefined) a[`trae.model_proxy.request.${key}`] = requestBody[key];
      }
      a['trae.model_proxy.request_body'] = requestBody;
      a['trae.model_proxy.status'] = resp.status ?? null;
      a['trae.model_proxy.is_sse'] = resp.is_sse ?? null;
      a['trae.model_proxy.delta_chars'] = resp.sse_total_delta_chars ?? null;
      a['trae.model_proxy.reasoning_chars'] = resp.sse_total_reasoning_chars ?? null;
      a['trae.model_proxy.request_body_chars'] = req.body_chars ?? null;
      a['trae.model_proxy.response_body_chars'] = resp.body_chars ?? null;
      a['trae.model_proxy.messages_summary'] = req.messages_summary ?? null;
      if (resp.sse_text) {
        a['gen_ai.output.messages'] = [{
          role: 'assistant',
          parts: [
            ...(resp.sse_reasoning_text ? [{ type: 'reasoning', content: resp.sse_reasoning_text }] : []),
            { type: 'text', content: resp.sse_text },
          ],
          finish_reason: 'stop',
        }];
        a['trae.output.provenance'] = 'custom_model_proxy:SSE 完整输出';
        a['trae.output.complete'] = true;
      }
      a['trae.model_proxy.sse_text'] = resp.sse_text ?? null;
      a['trae.model_proxy.sse_reasoning_text'] = resp.sse_reasoning_text ?? null;
      if (resp.sse_total_reasoning_chars === 0) {
        a['gen_ai.observability.missing.reasoning'] = true;
        a['gen_ai.observability.missing.reasoning.reason'] = 'custom_model_proxy_sse_has_no_reasoning_delta';
      }
    }
  }
  return { count: orderedPairs.length, matched };
}

export async function buildTrace(options = {}) {
  const sessionId = options.sessionId || DEFAULT_SESSION_ID;
  const sessionFilter = sessionId === 'all' ? null : sessionId;

  let logSession = findLatestLogSession();
  if (!logSession) {
    return {
      ok: false,
      error: '未找到 TRAE CN 的 ai-agent stdout 日志，请确认 TRAE CN 已运行过',
      sessionId,
    };
  }

  let parsed = await parseAgentLog(logSession.agentLog, { sessionFilter });

  // 要找的 session 不在这份日志里（常见于开了多个 TRAE 窗口 —— 每个窗口
  // 各自一份 logs/<时间戳>/ 目录）。换到真正包含它的那份重试，
  // 而不能用当前日志的其他 session 充数。
  //
  // 字面预筛会有假阳（`recently used sessions` 列表、payload 回灌），
  // 所以逐个候选真解析一遍，以 sessionMatch === 'exact' 为准。
  const tried = [logSession.name];
  if (sessionFilter && parsed.sessionMatch === 'absent') {
    for (const cand of findLogSessionsMentioning(sessionFilter)) {
      if (cand.agentLog === logSession.agentLog) continue;
      const retry = await parseAgentLog(cand.agentLog, { sessionFilter });
      tried.push(cand.name);
      if (retry.sessionMatch === 'exact') {
        logSession = cand;
        parsed = retry;
        break;
      }
    }
  }
  if (sessionFilter && parsed.sessionMatch === 'absent') {
    return {
      ok: false,
      error: `session ${sessionId} 不在任何一份 TRAE 日志里（已查：${tried.join(', ')}）。`
        + `日志可能已被 TRAE 轮转删除。`,
      sessionId,
      availableSessions: parsed.sessions,
      logDir: logSession.name,
      triedLogDirs: tried,
    };
  }

  const { turns, sessions, stats, confirmWaits } = parsed;

  const toolhostLogPath = findToolhostLog(logSession.modular);
  const jobsDir = findJobsDir();

  const [jobMap, hookEvents] = await Promise.all([
    parseToolhostLog(toolhostLogPath),
    Promise.resolve(loadHookEvents()),
  ]);

  const hookIndex = indexHookEvents(hookEvents);
  // Agent 身份/能力来自渲染端的明文 state.vscdb（与日志、hook 互补）
  const agentIdentity = readAgentIdentity();

  const traces = turns.map((turn, idx) =>
    buildTurnTrace(turn, idx, { jobMap, jobsDir, hookIndex, sessionId, agentIdentity, confirmWaits }),
  );
  const modelCapture = enrichTracesWithModelCapture(traces, loadModelCaptures());

  return {
    ok: true,
    sessionId,
    generatedAt: Date.now(),
    sources: {
      agentLog: logSession.agentLog,
      agentLogDir: logSession.name,
      toolhostLog: toolhostLogPath,
      jobsDir,
      hookEventsCount: hookEvents.length,
      modelCapture,
      // hook 未配置时前端给出显式提示，避免误以为“采集失败”
      hookConfigured: hookEvents.length > 0,
    },
    stats: {
      ...stats,
      turnCount: traces.length,
      observedSessions: sessions,
    },
    traces,
  };
}

/**
 * 把一轮里的主/子智能体谱系算清楚，供 AGENT / STEP / TOOL 三处共用。
 *
 * 归属依据【实测】：
 * - `[SubAgentCreate]` / `[SubAgentFinish]` 是唯一可靠的委派括号，Finish 一行
 *   同时给出子智能体类型（agent_id）与派发它的父工具调用 id。
 * - 每个工具与每次推理都带 agent_run_id，拿它对 subAgents 就能逐个定归属。
 * - 主 Agent 的 run id = 出现过但不属于任何子智能体的那个。
 */
function subAgentContext(turn, ctx) {
  const subs = (turn.subAgents || []).filter(s => s.agentRunId);
  const subIds = new Set(subs.map(s => s.agentRunId));
  // 候选 run id 两个来源都要：工具侧（execute_toolcall）与推理侧（AgentStatus）。
  // 只靠工具侧会在无工具的轮次里拿不到主 run id。
  const seen = [
    ...(turn.toolCallIds || []).map(x => x.agentRunId),
    ...(turn.agentStatuses || []).map(x => x.agentRunId),
  ].filter(Boolean);
  const mainRunId = seen.find(id => !subIds.has(id)) || null;
  // 主 Agent 的**声明** id（实测 solo_agent）——这也是 AGENT span 上的 gen_ai.agent.id
  const mainAgentId = ctx?.agentIdentity?.sessionAgent?.get(turn.sessionId || ctx?.sessionId) || null;

  // run id → 该 run 的层级属性（直接用于 STEP / TOOL）
  const byRun = new Map();
  if (mainRunId) {
    byRun.set(mainRunId, { scope: 'main', depth: 0, agentId: mainAgentId, runId: mainRunId });
  }
  for (const s of subs) {
    byRun.set(s.agentRunId, {
      scope: 'subagent',
      depth: 1,
      agentId: s.agentId,
      runId: s.agentRunId,
      parentAgentId: mainAgentId,
      parentRunId: mainRunId,
      parentToolCallId: s.parentToolCallId,
    });
  }
  return { subs, subIds, mainRunId, mainAgentId, byRun };
}

/**
 * 把一个 run 的层级属性写到 span attrs 上（词汇对齐仓库的
 * GEN_AI_HIERARCHY_PASSTHROUGH_KEYS）。
 *
 * 身份字段一律用**声明 id**（solo_agent / search），run 实例 id 归
 * `trae.agent.run_id`。这与 Codex 那边拿 thread id 当 agent.id 的口味不同，
 * 原因是本 trace 的 AGENT span 上 `gen_ai.agent.id` 就是声明 id；
 * 若这里的 `gen_ai.agent.parent.id` 填 run UUID，trace 内没任何 span 的
 * agent.id 等于它，就成了**悬空引用**。Codex 没有“每个线程的声明 id”
 * 这个概念，TRAE 有，所以以可解析为先。
 */
function applyRunScope(attrs, info) {
  if (!info) return attrs;
  attrs['gen_ai.agent.scope'] = info.scope;
  attrs['gen_ai.agent.depth'] = info.depth;
  if (info.runId) attrs['trae.agent.run_id'] = info.runId;
  if (info.scope === 'subagent') {
    if (info.agentId) {
      attrs['gen_ai.agent.id'] = info.agentId;
      attrs['gen_ai.agent.name'] = info.agentId;
    }
    if (info.parentAgentId) attrs['gen_ai.agent.parent.id'] = info.parentAgentId;
    if (info.parentRunId) attrs['trae.agent.parent.run_id'] = info.parentRunId;
    if (info.parentToolCallId) attrs['gen_ai.subagent.parent_tool_call.id'] = info.parentToolCallId;
  }
  return attrs;
}

/**
 * Agent 身份 / 能力 / 子智能体谱系，属性命名对齐仓库已有约定
 * （见 src/inputs/codex-transcript 与 otlp-trace-flusher 的
 *  GEN_AI_HIERARCHY_PASSTHROUGH_KEYS）。
 *
 * ⚠️ 子智能体**不能建成嵌套 AGENT span**：仓库 validator 的
 * `structure.single_agent` 要求一个 trace 恰好 1 个 AGENT，
 * `agent_under_entry` 要求它的父是 ENTRY。Codex 的做法是把子智能体
 * **融合进父 trace**，靠 agent.scope / agent.depth / agent.parent.id 区分归属，
 * 这里沿用同一套。
 *
 * 数据来源两头：
 * - 渲染端 state.vscdb：Agent 声明（名字 / 描述 / 内置工具 / 成员）
 * - ai-agent 日志：本轮实际跑了哪些 run（含子智能体委派）
 */
function agentIdentityAttrs(turn, ctx) {
  const attrs = {};
  const identity = ctx.agentIdentity;
  const sessionId = turn.sessionId || ctx.sessionId;

  // ---- 声明侧：这个 Agent 是谁、被允许用什么能力 ----
  const agentId = identity?.sessionAgent?.get(sessionId) || null;
  const decl = agentId ? identity?.agents?.get(agentId) : null;
  if (agentId) attrs['gen_ai.agent.id'] = agentId;
  if (decl) {
    attrs['gen_ai.agent.name'] = decl.name;
    attrs['gen_ai.agent.description'] = decl.description || null;
    // 内置能力开关：readonly/edit/terminal/preview/web_search
    // → 阅读/编辑/终端/预览/联网搜索。这决定了本轮**可能**出现哪些工具。
    attrs['trae.agent.builtin_tools'] = decl.builtinTools;
    attrs['trae.agent.builtin_tools_label'] = decl.builtinToolLabels.join('/');
    // members = 可被它调用的子智能体（实测 solo_agent 包含 search）
    attrs['trae.agent.members'] = decl.members;
    attrs['trae.agent.is_merged'] = decl.isMergedAgent;
    attrs['trae.agent.can_be_sub_agent'] = decl.canBeSubAgent;
    attrs['trae.agent.mcp_count'] = decl.mcpCount;
    attrs['trae.agent.has_custom_prompt'] = decl.hasCustomPrompt;
  }
  // 日志侧的成员声明：与 state.vscdb 互相佐证，且在读不到库时仍可用
  if ((turn.declaredSubAgents || []).length > 0) {
    attrs['trae.agent.sub_agents_declared'] = turn.declaredSubAgents;
  }
  const planMode = identity?.planMode?.get(sessionId);
  if (typeof planMode === 'boolean') attrs['trae.agent.plan_mode'] = planMode;

  // ---- 运行侧：本轮到底是主 Agent 自己跑还是委派给了子智能体 ----
  const { subs, mainRunId } = subAgentContext(turn, ctx);
  const runIds = [...new Set((turn.toolCallIds || []).map(t => t.agentRunId).filter(Boolean))];
  if (runIds.length > 0) attrs['trae.agent.run_ids'] = runIds;

  // AGENT span 恒为**主** Agent：子智能体不能建成嵌套 AGENT（见上方说明），
  // 它的归属落在各自的 STEP / TOOL 上。
  attrs['gen_ai.agent.scope'] = 'main';
  attrs['gen_ai.agent.depth'] = 0;
  if (mainRunId) attrs['trae.agent.run_id'] = mainRunId;

  if (subs.length > 0) {
    attrs['trae.subagent.observed'] = true;
    attrs['trae.subagent.count'] = subs.length;
    attrs['trae.subagent.ids'] = subs.map(s => s.agentId).filter(Boolean);
    // 委派占掉的壁钟：主 Agent 在这段时间里是挂起的，但轮次总时长包含它
    const waited = subs.reduce(
      (m, s) => m + (s.createMs != null && s.finishMs != null ? s.finishMs - s.createMs : 0), 0,
    );
    if (waited > 0) attrs['trae.subagent.total_duration_ms'] = waited;
    attrs['trae.subagent.evidence'] = 'SubAgentCreate / SubAgentFinish 括号完整，且工具带子智能体的 agent_run_id';
  } else {
    // 没委派≠采不到，把依据写清楚，否则会被当成采集遗漏去查。
    attrs['trae.subagent.observed'] = false;
    attrs['trae.subagent.evidence'] = (turn.declaredSubAgents || []).length > 0
      ? `声明了子智能体成员（${turn.declaredSubAgents.join('/')}）但本轮无 SubAgentCreate/Finish，即未被调用`
      : '本轮无 SubAgentCreate/Finish，且未声明子智能体成员';
  }
  return attrs;
}

/**
 * Harness 装配结果 → AGENT span 属性。
 *
 * TRAE 在首次推理前的 ~20ms 内把一整套底座拼好：子智能体名册、MCP、
 * 规则护栏、技能引擎、记忆开关。这些是「本轮 Agent 到底带着什么能力
 * 上场」的唯一本地证据——不标出来，就只能看到它调了哪些工具，
 * 看不到它本来可以调什么、又被哪些护栏约束着。
 *
 * 【为何不建成 span】实测装配窗口只有 22ms / 19ms，在瀑布图上是一根
 * 看不见的细丝；而且它前面那段 1.2s 的空白已经由 pilot.hook 与
 * context.resolve.* 事件交代过了。装配的价值在**内容**而不在耗时，
 * 所以落成属性 + 里程碑事件，而不再自造一个 span kind。
 *
 * 【拿不到的】规则与记忆的**内容**全在服务端，本地只有数量与开关。
 * 宁可只报数量，也不能拿磁盘上的文件冒充「注入进 prompt 的规则」。
 */
function harnessAttrs(turn) {
  const h = turn.harness;
  if (!h) return {};
  const attrs = {};

  if (h.beginMs != null && h.endMs != null) attrs['trae.harness.assemble_ms'] = h.endMs - h.beginMs;
  if (h.agentId) attrs['trae.harness.root_agent.id'] = h.agentId;
  if (h.configName) attrs['trae.harness.model_config'] = h.configName;

  // ---- 子智能体集群（声明侧）----
  // 注意与 trae.subagent.observed 的区别：这里是「名册里有谁」，
  // 那里是「本轮真的派了谁」。两者常不相等。
  if (h.rosterTotal != null) attrs['trae.harness.roster.total'] = h.rosterTotal;
  if (h.rosterMembers != null) attrs['trae.harness.roster.member_count'] = h.rosterMembers;

  // ---- 上下文引擎：MCP ----
  if (h.mcpServerCount != null) attrs['trae.harness.mcp.server_count'] = h.mcpServerCount;
  if (h.mcpCountAmbiguous) {
    // 归属不了就说归属不了，不拿“最近的那个”蒙成一个数
    attrs['trae.harness.mcp.count_unattributable'] = `窗口内有 ${h.mcpCountAmbiguous} 个观测点，无法确定归属（该日志行不带 trace_id）`;
  }
  if (h.mcpScanBeginMs != null && h.mcpScanEndMs != null) {
    attrs['trae.harness.mcp.scan_ms'] = h.mcpScanEndMs - h.mcpScanBeginMs;
  }

  // ---- 上下文引擎：云端回执 ----
  // 实测可能 0 次（Trace2），所以 0 次时不写 environment_used，
  // 否则 false 会被读成「环境上下文没被用」，而真相是「云端没回执」。
  const cus = h.contextUsages || [];
  attrs['trae.harness.context.usage_report_count'] = cus.length;
  if (cus.length > 0) {
    attrs['trae.harness.context.environment_used'] = cus[0].environmentUsed;
    attrs['trae.harness.context.rendered_file_rules'] = cus[0].fileRulePaths;
  }

  // ---- 规则与护栏 ----
  if (h.rules) {
    attrs['trae.harness.rules.global_count'] = h.rules.globalCount ?? null;
    attrs['trae.harness.rules.project_types'] = h.rules.projectTypes || [];
    attrs['trae.harness.rules.should_mask'] = h.rules.shouldMask ?? null;
    attrs['trae.harness.rules.injected_chars'] = h.rules.totalChars ?? null;
    attrs['trae.harness.rules.max_chars'] = h.rules.maxChars ?? null;
    attrs['trae.harness.rules.content_available'] = false;
  }

  // ---- 技能引擎 ----
  const skills = h.skills || [];
  const loaded = skills.filter(s => s.state === 'loaded');
  attrs['trae.harness.skills.candidate_count'] = skills.length;
  attrs['trae.harness.skills.loaded_count'] = loaded.length;
  attrs['trae.harness.skills.loaded'] = loaded.map(s => s.name);
  // 按来源分组：三个目录的意义完全不同（内置自带 / AB 下发 / 用户自建），
  // 堆成一个数就看不出「用户自己写的技能到底有没被加载」。
  const bySource = {};
  for (const s of loaded) (bySource[s.source] ??= []).push(s.name);
  if (bySource.builtin_global) attrs['trae.harness.skills.builtin_global'] = bySource.builtin_global;
  if (bySource.local_builtin) attrs['trae.harness.skills.local_builtin'] = bySource.local_builtin;
  if (bySource.user_global) attrs['trae.harness.skills.user_global'] = bySource.user_global;
  const unresolved = skills.filter(s => s.state !== 'loaded').map(s => s.name);
  if (unresolved.length > 0) attrs['trae.harness.skills.unresolved'] = unresolved;
  if ((h.skillsRemoved || []).length > 0) {
    attrs['trae.harness.skills.gated_out'] = h.skillsRemoved.map(s => s.name);
  }

  // ---- 记忆系统 ----
  if (h.memory) {
    attrs['trae.harness.memory.chat_enabled'] = h.memory.chatMemory;
    attrs['trae.harness.memory.core_enabled'] = h.memory.coreMemory;
    // 记忆内容在服务端，本地只能看到开关——说清楚，避免被当成采集遗漏。
    attrs['trae.harness.memory.content_available'] = false;
  }

  return attrs;
}

/**
 * 把 scope=subagent 的连续 STEP 包裹进独立的 SUBAGENT span。
 *
 * 输入：扁平的 STEP 列表（主智能体 + 子智能体混合）
 * 输出：STEP 与 SUBAGENT span 交替的列表，作为 AGENT span 的直接 children
 *
 * 每个 SUBAGENT span 的时间范围从 SubAgentCreate 到 SubAgentFinish，
 * 不是仅仅覆盖其内部 STEP 的范围（前者包含了子智能体汇报总结的时间）。
 */
function wrapSubAgentSpans(steps, subCtx, turn) {
  if (!subCtx.subs.length) return steps;

  const result = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    const scope = step.attributes?.['gen_ai.agent.scope'];
    if (scope !== 'subagent') {
      result.push(step);
      i++;
      continue;
    }
    // 找到这段连续 subagent STEP 属于哪个子智能体
    const runId = step.attributes?.['trae.agent.run_id'];
    const sub = subCtx.subs.find(s => s.agentRunId === runId) || subCtx.subs[0];

    // 收集属于同一个子智能体的连续 STEP
    const group = [];
    while (i < steps.length) {
      const s = steps[i];
      if (s.attributes?.['gen_ai.agent.scope'] !== 'subagent') break;
      const rid = s.attributes?.['trae.agent.run_id'];
      if (rid && rid !== runId) break; // 不同的子智能体，开新一组
      group.push(s);
      i++;
    }

    // 建 SUBAGENT span。时间范围要同时包住两头：
    // - SubAgentCreate/Finish（含子智能体汇报总结的时间）
    // - 内部 STEP 的实际起止（子智能体第一次推理实测比 SubAgentCreate 打点早 ~466ms）
    // 取交集会让 STEP 溢出父 span，违反 child_within_parent，所以取并集。
    const groupStart = Math.min(...group.map(s => s.startMs));
    const groupEnd = Math.max(...group.map(s => s.endMs));
    const startMs = Math.min(sub.createMs || groupStart, groupStart);
    const endMs = Math.max(sub.finishMs || groupEnd, groupEnd);
    const subAttrs = {
      'gen_ai.span.kind': 'SUBAGENT',
      'gen_ai.operation.name': 'invoke_subagent',
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.depth': 1,
      'gen_ai.agent.name': sub.agentId || 'unknown',
      'gen_ai.agent.id': sub.agentRunId,
      'gen_ai.agent.parent.id': subCtx.mainAgentId,
      'gen_ai.subagent.parent_tool_call.id': sub.parentToolCallId,
      'trae.agent.run_id': sub.agentRunId,
      'trae.subagent.status': sub.status,
      'trae.subagent.step_count': group.length,
      'trae.subagent.tool_count': group.reduce((n, s) => n + (s.children || []).filter(c => c.kind === 'TOOL').length, 0),
    };
    const subSpan = span('SUBAGENT', `subagent ${sub.agentId || 'unknown'}`, startMs, endMs, subAttrs, group);
    result.push(subSpan);
  }
  return result;
}

function buildTurnTrace(turn, idx, ctx) {
  const { hookIndex } = ctx;

  const beginMs = beginOf(turn);
  const lastMs = lastTimingMs(turn);
  // 轮次结束：取 timing 末点、工具末点、日志末点三者最大
  const toolEnd = turn.tools.reduce((m, t) => Math.max(m, t.endMs || 0), 0);
  const endMs = Math.max(lastMs || 0, toolEnd, turn.lastMs || 0, beginMs);

  const resolversBegin = pick(turn, 'rs_06_resolvers_begin');
  const resolveContexts = pick(turn, 'rs_06_resolve_contexts');
  const processTask = pick(turn, 'rs_09_process_task');
  const renderPrompt = pick(turn, 'rs_13_render_user_prompt');

  // 第一次推理的起点；rs_16 缺失时依次退到 rs_15 / prompt 渲染完成 / 进入执行
  const firstLlmStart = pick(turn, 'rs_16_llm_generate_plain_item')
    || pick(turn, 'rs_15_before_generate_plan')
    || renderPrompt
    || processTask
    || beginMs;

  const userPrompt = hookIndex.matchPrompt(beginMs, endMs);
  const response = hookIndex.matchResponse(beginMs, endMs);

  // ---- STEP：一次 ReAct 迭代 = 1 个 LLM + 该次推理下发的 N 个 TOOL ----
  const rounds = partitionRounds(turn, endMs, firstLlmStart);
  // 等用户手动确认的区间。得在建 STEP 之前算好：TOOL span 要靠 call_xxx 查它。
  const confirmWaits = (ctx.confirmWaits || []).filter(w => w.beginMs >= beginMs - 1000 && w.beginMs <= endMs);
  const confirmByCallId = new Map();
  for (const w of confirmWaits) {
    for (const id of w.callIds) confirmByCallId.set(id, w);
  }
  const subCtx = subAgentContext(turn, ctx);
  const shared = {
    firstTokens: pickAll(turn, 'rs_18_llm_response_first_token'),
    // commit 载荷里的 toolcall_resp：非 RunCommand 工具结果在本地的唯一来源
    resultPool: turn.toolResults.map(r => ({ ...r, used: false })),
    cmdQueue: [...turn.commands],
    // 搜索记录池：一次搜索只能被一个 WebSearch span 领走
    searchPool: (turn.webSearches || []).map(s => ({ ...s, used: false })),
    confirmByCallId,
    // 主/子智能体归属：STEP 与 TOOL 都靠它把 agent_run_id 翻成层级属性
    runScope: subCtx.byRun,
    subs: subCtx.subs,
    noNeedExecutes: turn.noNeedExecutes || [],
    response,
  };
  const steps = rounds.map(round => buildStepSpan(round, turn, ctx, shared));
  // TOOL span 建完后才能回填 LLM 的输入/输出消息（依赖工具的参数/结果）
  fillLlmMessages(steps, userPrompt ? userPrompt.prompt : null);

  // ---- SUBAGENT 包裹：把 scope=subagent 的连续 STEP 收进独立的 SUBAGENT span ----
  // 不加这层的话，子智能体的 10 个 STEP 和主智能体的 3 个 STEP 平铺在 AGENT 下面，
  // 前端看起来就是同一个 agent 在跑——根本分不出哪些是 Search Agent 在干活。
  const agentChildren = wrapSubAgentSpans(steps, subCtx, turn);

  // ---- AGENT ----
  // 准备阶段（上下文收集 / prompt 渲染）不是 ReAct 迭代，无 LLM 调用，
  // 因此不能建成 STEP（STEP 必须恰好含 1 个 LLM），改挂为 AGENT 上的 span event + 耗时属性。
  //
  // 这里要把轮次生命周期的 rs_* 事件都挂上，否则首个 LLM 请求之前的预处理时间
  // （实测约 1.2s：取会话 / 取历史 / 建消息 / 取模型 / 建任务 / 建轮次 / 快照）
  // 在轨迹里是一段无任何交代的空白，看起来像采集漏了东西。
  const agentEvents = [];
  for (const [timing, label] of LIFECYCLE_EVENTS) {
    const at = pick(turn, timing);
    if (at) agentEvents.push({ name: label, atMs: at });
  }
  if (resolversBegin) agentEvents.push({ name: 'context.resolve.begin', atMs: resolversBegin });
  for (const name of RESOLVER_EVENTS) {
    const at = pick(turn, name);
    if (at) agentEvents.push({ name: name.replace('rs_06_resolver_', 'context.resolver.'), atMs: at });
  }
  if (resolveContexts) agentEvents.push({ name: 'context.resolve.end', atMs: resolveContexts });
  if (renderPrompt) agentEvents.push({ name: 'prompt.render.end', atMs: renderPrompt });
  // 叶子 span 之间的相位标记（工具流式到达 / 审批 / 结果提交 / 轮次收尾）。
  // 没这些的话实测会留下 4 段共 3s 无交代的空白（见 audit-coverage.mjs）。
  for (const p of turn.phases || []) agentEvents.push({ name: p.name, atMs: p.atMs });
  // 采集器自身的阻塞开销：这是本地采集引入的真实壁钟成本（TRAE 同步等 hook 返回），
  // 实测占整轮 17%~30%。把每次 hook 标成带区间的事件，同时汇总到 AGENT 属性上。
  const hookExecs = (turn.hookExecs || []).filter(h => Number.isFinite(h.beginMs) && Number.isFinite(h.endMs));
  for (const h of hookExecs) {
    agentEvents.push({ name: `pilot.hook:${h.event}`, atMs: h.beginMs, attributes: { 'pilot.hook.duration_ms': h.endMs - h.beginMs } });
  }
  const hookTotalMs = hookExecs.reduce((s, h) => s + (h.endMs - h.beginMs), 0);
  // 等用户手动确认的阻塞时间。它与 hook 开销同类（带区间的事件），但意义相反：
  // 这是**人在想**的时间，不应计入 Agent 的性能账。不标出来的话，一段 18 秒的
  // 确认等待在轨迹上就是纯空白，会被当成 Agent 卡顿去查。
  for (const w of confirmWaits) {
    agentEvents.push({
      name: 'user.confirm.wait',
      atMs: w.beginMs,
      attributes: {
        'trae.confirm.wait_ms': w.endMs - w.beginMs,
        'trae.confirm.reason': w.reason,
        'gen_ai.tool.call.id': w.callIds[0] || null,
      },
    });
  }
  // Harness 装配的里程碑。只标两头 + 三个关键节点：22ms 里塞不下更细的，
  // 而且细节已经在 AGENT 属性里了，事件只负责告诉读者「这几毫秒在干什么」。
  const hn = turn.harness;
  if (hn) {
    if (hn.beginMs != null) agentEvents.push({ name: 'harness.assemble.begin', atMs: hn.beginMs });
    if (hn.rosterTotal != null && hn.beginMs != null) {
      agentEvents.push({
        name: 'harness.roster.built',
        atMs: hn.beginMs,
        attributes: { 'trae.harness.roster.total': hn.rosterTotal },
      });
    }
    if (hn.mcpScanEndMs != null) agentEvents.push({ name: 'harness.mcp.scanned', atMs: hn.mcpScanEndMs });
    const loadedCount = (hn.skills || []).filter(s => s.state === 'loaded').length;
    if (loadedCount > 0 && hn.endMs != null) {
      agentEvents.push({
        name: 'harness.skills.resolved',
        atMs: hn.endMs,
        attributes: { 'trae.harness.skills.loaded_count': loadedCount },
      });
    }
    if (hn.endMs != null) agentEvents.push({ name: 'harness.assemble.end', atMs: hn.endMs });
    // 云端回执是异步的，按它自己的时刻标——实测有一次落在推理中途
    // 90 秒处，硬把它挖到装配窗口里就是管时间。
    for (const c of hn.contextUsages || []) {
      if (c.atMs != null) {
        agentEvents.push({
          name: 'harness.context.usage_report',
          atMs: c.atMs,
          attributes: { 'trae.harness.context.environment_used': c.environmentUsed },
        });
      }
    }
  }
  const confirmTotalMs = confirmWaits.reduce((s, w) => s + (w.endMs - w.beginMs), 0);
  agentEvents.sort((a, b) => a.atMs - b.atMs);

  const agentStart = Math.min(
    ...[resolversBegin, processTask, steps[0] ? steps[0].startMs : null, beginMs]
      .filter(v => Number.isFinite(v) && v > 0),
  );
  const agentAttrs = {
    'gen_ai.span.kind': 'AGENT',
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': turn.agentType || 'solo_agent',
    'gen_ai.system': 'trae-cn',
    'gen_ai.conversation.id': turn.sessionId || ctx.sessionId,
    'gen_ai.request.model': turn.model.requestModel || null,
    'gen_ai.response.model': turn.model.responseModel || null,
    'trae.react.rounds': rounds.length,
    'trae.context.resolve_ms': resolversBegin && resolveContexts ? resolveContexts - resolversBegin : null,
    'trae.prompt.render_ms': processTask && renderPrompt ? renderPrompt - processTask : null,
    // 采集器自身开销（诚实披露）：hook 调用总次数与阻塞总耗时。
    'pilot.hook.count': hookExecs.length || null,
    'pilot.hook.total_ms': hookExecs.length ? hookTotalMs : null,
    'pilot.hook.overhead_pct': hookExecs.length && endMs > beginMs
      ? Math.round((hookTotalMs / (endMs - beginMs)) * 1000) / 10
      : null,
    // 等人的时间：把它从“Agent 耗时”里区分出来，否则会把用户自己思考的
    // 18 秒算成 Agent 慢。
    'trae.confirm.count': confirmWaits.length || null,
    'trae.confirm.total_wait_ms': confirmWaits.length ? confirmTotalMs : null,
    ...agentIdentityAttrs(turn, ctx),
    ...harnessAttrs(turn),
  };
  const agentSpan = span(
    'AGENT',
    `invoke_agent ${turn.agentType || 'trae-cn'}`,
    agentStart,
    endMs,
    agentAttrs,
    agentChildren,
  );
  if (agentEvents.length > 0) agentSpan.events = agentEvents;

  // ---- ENTRY（轮次根 span）----
  const entryAttrs = {
    'gen_ai.span.kind': 'ENTRY',
    'gen_ai.operation.name': 'enter',
    'gen_ai.system': 'trae-cn',
    'gen_ai.conversation.id': turn.sessionId || ctx.sessionId,
    'trae.trace.id': turn.traceId,
    'trae.turn.index': idx + 1,
    'trae.react.rounds': rounds.length,
    'trae.span.path': turn.spanPaths.slice(0, 3),
  };
  if (userPrompt) {
    entryAttrs['gen_ai.input.messages'] = userPrompt.prompt;
    entryAttrs['trae.prompt.source'] = 'hook:UserPromptSubmit';
  } else {
    entryAttrs['gen_ai.input.messages'] = null;
    entryAttrs['trae.prompt.availability'] = '需 UserPromptSubmit hook 补齐';
  }

  // Stop hook 带回思考过程、助手回复与 token 用量。
  // 内容同时落在末次迭代的 LLM span 上（见 buildLlmSpan）——那才是产出最终回答的那次推理；
  // 这里的轮次根 span 只做 turn 级汇总，便于列表页直接看到问答对。
  if (response) {
    if (response.reasoning) entryAttrs['gen_ai.output.reasoning'] = response.reasoning;
    if (response.responseText) entryAttrs['gen_ai.output.messages'] = response.responseText;
    if (response.finishReason) entryAttrs['gen_ai.response.finish_reason'] = response.finishReason;
    if (response.usage?.input != null) entryAttrs['gen_ai.usage.input_tokens'] = response.usage.input;
    if (response.usage?.output != null) entryAttrs['gen_ai.usage.output_tokens'] = response.usage.output;
    if (response.usage?.total != null) entryAttrs['gen_ai.usage.total_tokens'] = response.usage.total;
    entryAttrs['trae.response.source'] = 'hook:Stop';
  } else {
    entryAttrs['gen_ai.output.messages'] = null;
    entryAttrs['trae.response.availability'] = '需 Stop hook 补齐';
  }

  const entryStart = Math.min(beginMs, agentStart);
  const entrySpan = span(
    'ENTRY',
    'enter_ai_application_system',
    entryStart,
    endMs,
    entryAttrs,
    [agentSpan],
  );

  return {
    traceId: turn.traceId,
    sessionId: turn.sessionId || ctx.sessionId,
    turnIndex: idx + 1,
    startMs: entryStart,
    endMs,
    durationMs: endMs - entryStart,
    toolCount: turn.tools.length,
    stepCount: rounds.length,
    root: entrySpan,
    timings: turn.timings.slice().sort((a, b) => a.epochMs - b.epochMs),
    serverTimings: turn.serverTimings,
  };
}

/**
 * 把日志里的 LLM 侧 tool call id（call_xxx）与工具真实起点挂到工具 span 上。
 *
 * `[execute_toolcall]` 与 `Run tool X finished` 的先后顺序不固定（见 parse-agent-log 的说明），
 * 所以不能按时间就近配，而是按同名工具的出现次序逐个对号：
 * 两个列表都是同一批底层事件的时序投影，第 k 个 `Read` 就对应第 k 个 `Read`。
 * `Start run tool` 同理。
 */
function attachToolCallIds(turn) {
  const idPool = groupByName(turn.toolCallIds || [], x => x.callId);
  const startPool = groupByName(turn.toolStarts || [], x => x.atMs);
  // 工具归属的 agent run（子智能体会是不同的 run id），与 callId 同一个源，按同样的次序对号
  const runPool = groupByName(turn.toolCallIds || [], x => x.agentRunId);
  const used = new Map();
  return turn.tools.map(t => {
    const k = used.get(t.name) || 0;
    used.set(t.name, k + 1);
    const out = { ...t };
    const ids = idPool.get(t.name);
    if (ids && k < ids.length) out.callId = ids[k];
    const starts = startPool.get(t.name);
    if (starts && k < starts.length) out.startMs = starts[k];
    const runs = runPool.get(t.name);
    if (runs && k < runs.length && runs[k]) out.agentRunId = runs[k];
    return out;
  });
}

function groupByName(list, valueOf) {
  const m = new Map();
  for (const item of list) {
    if (!m.has(item.name)) m.set(item.name, []);
    m.get(item.name).push(valueOf(item));
  }
  return m;
}

/**
 * 把一轮 turn 切成 ReAct 迭代（每个迭代 = 一个 STEP）。
 *
 * 边界依据【实测】：`[commit_toolcall_result] endpoint=` —— 把工具结果提交给服务端，
 * 服务端随即产出下一步计划，所以 commit 时刻就是「本次迭代结束 / 下次推理开始」。
 * 同一次推理并发下发的多个工具都在同一个 commit 之前完成，自然归到同一 STEP。
 *
 * 【实测】这也是唯一可靠的边界信号：hook 事件流推不出迭代边界，因为 TRAE 边流式
 * 接收 tool call 边执行，同一次 LLM 响应里的工具会以 Pre(A) → Post(A) → Pre(B) 的顺序到达。
 *
 * 已知近似：`Shell` 这类异步工具返回 status=Running，其结果提交与工具完成不严格一一对应，
 * 因此两次推理之间若没观测到 commit，会被合并成一次迭代。这是本地信号能给到的上限。
 */
function partitionRounds(turn, turnEndMs, firstLlmStartMs) {
  const tools = attachToolCallIds(turn)
    .map(t => ({ ...t, endMs: t.endMs || turnEndMs }))
    // 按日志时间戳（真实值）排序，不用 end-cost 反推的起点，避免估算误差改变归属
    .sort((a, b) => a.endMs - b.endMs);
  const commits = turn.commits.filter(ms => Number.isFinite(ms)).sort((a, b) => a - b);

  const batches = [];
  let cur = { tools: [], commitMs: null, agentRunId: null };
  let ci = 0;
  for (const tool of tools) {
    // 本工具完成之前发生的 commit 关闭上一批
    while (ci < commits.length && commits[ci] < tool.endMs) {
      const at = commits[ci];
      ci++;
      if (cur.tools.length > 0) {
        cur.commitMs = at;
        batches.push(cur);
        cur = { tools: [], commitMs: null, agentRunId: null };
      }
    }
    // 换人也关闭上一批。【实测】子智能体的结果**不走**本地
    // commit_toolcall_result（走 SubAgentFinish），所以不加这道判断时，子智能体
    // 最后几个工具会和主智能体恢复后的第一个工具被归到同一个 STEP，
    // 拼出一个 46 秒的假迭代（里面还夹着 33 秒的子智能体收尾总结）。
    if (cur.tools.length > 0 && tool.agentRunId && cur.agentRunId && tool.agentRunId !== cur.agentRunId) {
      cur.boundary = 'subagent_handoff';
      batches.push(cur);
      cur = { tools: [], commitMs: null, agentRunId: null };
    }
    if (!cur.agentRunId && tool.agentRunId) cur.agentRunId = tool.agentRunId;
    cur.tools.push(tool);
  }
  if (cur.tools.length > 0) {
    cur.commitMs = ci < commits.length ? commits[ci] : null;
    batches.push(cur);
  }

  const rounds = [];
  let llmStart = firstLlmStartMs;
  for (const batch of batches) {
    const firstToolStart = Math.min(...batch.tools.map(
      t => (Number.isFinite(t.startMs) ? t.startMs : t.endMs - (t.costMs || 0)),
    ));
    const prev = rounds[rounds.length - 1];
    rounds.push({
      index: rounds.length + 1,
      llmStartMs: llmStart,
      llmEndMs: Math.max(llmStart, firstToolStart),
      tools: batch.tools,
      commitMs: batch.commitMs,
      agentRunId: batch.agentRunId,
      // 上一迭代是因为换人才切开的，说明这两次输出来自**同一个** HTTP 响应流：
      // 【实测】服务端把“子智能体汇报 + 交还 + 主智能体继续”复用了一个流（该流
      // `plan final token cost: 43533ms` 反推的起点正好是上一次 commit），
      // 所以它不占一个新请求，不能参与下面按下标的请求回填。
      streamShared: prev?.boundary === 'subagent_handoff',
      boundary: batch.boundary || (batch.commitMs ? 'commit_toolcall_result' : 'turn_end'),
    });
    llmStart = batch.commitMs != null
      ? batch.commitMs
      : Math.max(...batch.tools.map(t => t.endMs));
  }

  // 收尾迭代是否真存在，以**服务端推理请求数**为准：
  // create_agent_task 算一次，每个 commit_toolcall_result 的响应就是下一次流。
  // 共流的交还迭代不占请求，比较时要先扣掉。
  //
  // 【已推翻】旧版用「最后一次 commit 后还剩 ≥800ms 就算一次收尾推理」的启发式，
  // 实测会**凭空造出一个不存在的 LLM span**：那段尾巴时间里日志只有
  // filter_files_outside_workspace / products_accumulation / snapshot diff / Stop hook
  // 这些收尾处理，并没有第三个 HTTP 请求。
  const llmCallCount = (turn.llmRequests || []).length;
  const sharedCount = rounds.filter(r => r.streamShared).length;
  const needFinalRound = llmCallCount > 0
    ? rounds.length - sharedCount < llmCallCount
    // 拿不到请求记录时（日志被截断等）至少保证无工具轮次仍有合法结构
    : batches.length === 0;

  if (needFinalRound) {
    rounds.push({
      index: rounds.length + 1,
      llmStartMs: llmStart,
      llmEndMs: turnEndMs,
      tools: [],
      commitMs: null,
      agentRunId: null,
      boundary: 'turn_end',
    });
  }

  // 把真实的请求时刻回填到各迭代的 LLM 起点（比用上一次 commit 时刻推断更准）。
  // 共流的交还迭代跳过：它没有自己的请求，按下标硬对会把后面所有轮次都错一位。
  const requestRounds = rounds.filter(r => !r.streamShared);
  (turn.llmRequests || [])
    .slice()
    .sort((a, b) => a.atMs - b.atMs)
    .forEach((req, i) => {
      const r = requestRounds[i];
      if (!r) return;
      r.llmStartMs = req.atMs;
      r.llmEndMs = Math.max(req.atMs, r.llmEndMs);
      r.llmRequestKind = req.kind;
    });

  // 共流迭代的 LLM 起点：取前一个 agent 交还的时刻（SubAgentFinish）。
  // 不能沿用前一轮的请求时刻，那会让两个 LLM span 大片重叠；
  // 交还时刻到首个工具起点这段，才是“本 agent 在这个流里输出”的部分。
  for (const r of rounds) {
    if (!r.streamShared) continue;
    const handoff = (turn.subAgents || [])
      .map(s => s.finishMs)
      .filter(ms => ms != null && ms <= r.llmEndMs)
      .sort((a, b) => b - a)[0];
    if (handoff != null) {
      r.llmStartMs = handoff;
      r.llmEndMs = Math.max(handoff, r.llmEndMs);
    }
    r.llmRequestKind = 'shared_stream';
  }

  // 无工具的迭代（收尾轮，或工具只有无 call id 的 finish）拿不到 agent_run_id，
  // 用推理侧的 AgentStatus 兜底：它与 `plan final token cost` 同刻上报本次流的归属。
  // 必须放在上面的请求时刻回填之后：那一步会把 llmStartMs 换成真实 HTTP 请求时刻，
  // 拿更准的起点去找“之后的第一次收尾上报”才不会跨迭代拿错人。
  const statuses = (turn.agentStatuses || []).slice().sort((a, b) => a.atMs - b.atMs);
  for (const r of rounds) {
    if (r.agentRunId) continue;
    const own = statuses.find(s => s.atMs >= r.llmStartMs);
    if (own) r.agentRunId = own.agentRunId;
  }

  if (rounds.length > 0) rounds[rounds.length - 1].final = true;
  return rounds;
}

/** 一次 ReAct 迭代 → STEP span，children 恒为 [LLM, ...TOOL] */
function buildStepSpan(round, turn, ctx, shared) {
  const llmSpan = buildLlmSpan(round, turn, shared);
  const toolSpans = round.tools.map(tool => buildToolSpan(tool, turn, ctx, shared));

  // STEP 内 LLM 必须先于所有 TOOL 开始（先推理才有工具可执行）。
  // end-cost 估算的起点偶尔会越过迭代边界，这种情况夹到迭代起点；
  // 若是 toolhost state.json 给的真实起点，则反过来放宽 LLM 起点 —— 真实时间优先于推断。
  for (const s of toolSpans) {
    if (s.startMs >= llmSpan.startMs) continue;
    if (s.attributes['trae.start_estimated'] === false) {
      llmSpan.startMs = s.startMs;
      llmSpan.durationMs = llmSpan.endMs - llmSpan.startMs;
      llmSpan.attributes['trae.llm.start_adjusted'] = true;
    } else {
      s.attributes['trae.start_clamped'] = true;
      s.startMs = llmSpan.startMs;
      s.durationMs = Math.max(0, s.endMs - s.startMs);
    }
  }
  toolSpans.sort((a, b) => a.startMs - b.startMs);

  const children = [llmSpan, ...toolSpans];
  const startMs = children.reduce((m, c) => Math.min(m, c.startMs), llmSpan.startMs);
  const endMs = children.reduce((m, c) => Math.max(m, c.endMs), llmSpan.endMs);

  const attrs = {
    'gen_ai.span.kind': 'STEP',
    'gen_ai.operation.name': 'react',
    'gen_ai.step.id': `${turn.traceId}:s${round.index}`,
    'gen_ai.react.round': round.index,
    'trae.step.tool_count': round.tools.length,
    'trae.step.end_boundary': round.boundary,
  };
  // 这次迭代是主智能体还是子智能体在推理。实测一轮 12 次迭代里
  // 9 次属于 Search 子智能体，不标就全算到主智能体头上了。
  applyRunScope(attrs, round.agentRunId ? shared.runScope?.get(round.agentRunId) : null);
  const stepSpan = span('STEP', 'react step', startMs, endMs, attrs, children);
  stepSpan.status = toolSpans.some(t => t.status === 'ERROR') ? 'ERROR' : 'OK';
  return stepSpan;
}

/**
 * 重建 LLM 的输入/输出消息，在**全部 STEP 建完之后**跑。
 *
 * 为何不在 buildLlmSpan 里做：工具的参数/结果是在 buildToolSpan 里才从
 * hook / commit 载荷 / toolhost 产物三个源合并出来的，只有读建好的 TOOL span
 * 才能保证与实际展示的内容一致（否则两边会分叉）。
 *
 * 可重建的部分：
 * - 输出 = 本轮发出的工具调用（handle_stream ToolCall + hook:PreToolUse）
 * - 输入 = 首轮的用户 prompt（hook:UserPromptSubmit）+ 上一轮回灌的工具结果
 *
 * ⚠️ 仍不可得：system prompt 与完整历史（服务端拼装）、中间轮次的助手文本/思考过程
 * （只在 SSE 流里透传）。因此每个重建字段都带 provenance / complete / missing 三个标注，
 * 不冒充真实请求体。
 */
function fillLlmMessages(steps, userPromptText) {
  const toolCallParts = step => (step.children || [])
    .filter(c => c.kind === 'TOOL' && !INTERNAL_TOOLS.has(c.attributes['gen_ai.tool.name']))
    .map(c => ({
      type: 'tool_call',
      id: c.attributes['gen_ai.tool.call.id'] || null,
      name: c.attributes['gen_ai.tool.name'],
      arguments: c.attributes['gen_ai.tool.call.arguments'] ?? null,
    }));

  const toolResultMsgs = step => (step.children || [])
    .filter(c => c.kind === 'TOOL' && !INTERNAL_TOOLS.has(c.attributes['gen_ai.tool.name']))
    .map(c => ({
      role: 'tool',
      tool_call_id: c.attributes['gen_ai.tool.call.id'] || null,
      parts: [{ type: 'tool_call_response', response: c.attributes['gen_ai.tool.call.result'] ?? null }],
    }));

  steps.forEach((step, i) => {
    const llm = (step.children || []).find(c => c.kind === 'LLM');
    if (!llm) return;
    const a = llm.attributes;

    // ---- 输入 ----
    const input = [];
    if (i === 0 && userPromptText) {
      input.push({ role: 'user', parts: [{ type: 'text', content: userPromptText }] });
    }
    if (i > 0) input.push(...toolResultMsgs(steps[i - 1]));
    if (input.length > 0) {
      a['gen_ai.input.messages'] = input;
      a['trae.input.provenance'] = i === 0
        ? 'hook:UserPromptSubmit（仅用户消息）'
        : 'commit_toolcall_result 载荷（仅上一轮工具结果）';
      a['trae.input.complete'] = false;
      a['trae.input.missing'] = 'system prompt 与完整历史由服务端拼装（svr__02_preprocess_build_llm_prompt）';
    }

    // ---- 输出 ----
    const calls = toolCallParts(step);
    const existing = Array.isArray(a['gen_ai.output.messages']) ? a['gen_ai.output.messages'] : [];
    if (calls.length > 0) {
      // 工具调用消息排在最终回答之前（时序上先发工具再收尾）
      a['gen_ai.output.messages'] = [
        { role: 'assistant', parts: calls, finish_reason: 'tool_calls' },
        ...existing,
      ];
      a['trae.output.provenance'] = existing.length > 0
        ? 'handle_stream ToolCall + hook:Stop（工具调用 + 最终回答）'
        : 'handle_stream ToolCall + hook:PreToolUse（工具调用部分）';
      if (existing.length === 0) {
        a['gen_ai.response.finish_reasons'] = ['tool_calls'];
        a['trae.output.complete'] = false;
        a['trae.output.missing'] = '本轮助手文本 / 思考过程仅在 SSE 流里透传，不落盘';
      }
    }
  });
}

/** 迭代内的推理 → LLM span（输入/输出消息由 fillLlmMessages 回填） */
function buildLlmSpan(round, turn, shared) {
  const attrs = {
    'gen_ai.span.kind': 'LLM',
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': turn.model.requestModel || null,
    'gen_ai.response.model': turn.model.responseModel || null,
    'gen_ai.provider.name': turn.model.provider || null,
    'gen_ai.input.messages': null,
    'gen_ai.output.messages': null,
    'gen_ai.react.round': round.index,
    // 本次推理是哪个服务端请求发起的；拿不到请求记录时退回推断描述。
    // shared_stream 得单独说：它的起点不是 HTTP 请求时刻，而是上一个 agent
    // 交还的时刻（SubAgentFinish）——两个 agent 共用了一个响应流。
    'trae.llm.start_source': round.llmRequestKind === 'shared_stream'
      ? 'SubAgentFinish（与上一迭代共用同一个响应流）'
      : (round.llmRequestKind
        ? `HTTP ${round.llmRequestKind}`
        : (round.index === 1
          ? 'rs_16_llm_generate_plain_item'
          : 'commit_toolcall_result（上一迭代提交结果即本次推理开始）')),
    // 起点是否来自真实观测到的请求（false = 由边界推断）
    'trae.llm.start_observed': Boolean(round.llmRequestKind),
    // 本段输出与上一迭代共用同一个 HTTP 响应流（子智能体交还处）
    'trae.llm.stream_shared': round.llmRequestKind === 'shared_stream',
  };

  // 客户端侧的真实请求参数（[ModelConfig]）——这些不经服务端，本地完全可得
  const mp = turn.modelParams || {};
  if (mp.maxTokens != null) attrs['gen_ai.request.max_tokens'] = mp.maxTokens;
  if (mp.promptMaxTokens != null) attrs['trae.request.prompt_max_tokens'] = mp.promptMaxTokens;
  if (mp.maxTurn != null) attrs['trae.request.max_turn'] = mp.maxTurn;
  if (mp.configName) attrs['trae.request.config_name'] = mp.configName;
  if (mp.nativeFunctionCall != null) attrs['trae.request.native_function_call'] = mp.nativeFunctionCall;
  if (mp.passBackReasoning != null) attrs['trae.request.pass_back_reasoning'] = mp.passBackReasoning;

  // 首 token 只认落在本迭代窗口内的 rs_18：rs_NN 编号不代表先后，实测存在过期值（§6.2）
  const ttft = shared.firstTokens.find(ms => ms >= round.llmStartMs && ms <= round.llmEndMs);
  if (ttft) attrs['trae.llm.ttft_ms'] = ttft - round.llmStartMs;

  // svr_* 是轮次级聚合（日志在轮次收尾才输出一次），只挂第一次推理并标注口径，避免逐迭代重复
  if (round.index === 1 && Object.keys(turn.serverTimings).length > 0) {
    for (const [k, v] of Object.entries(turn.serverTimings)) attrs[`trae.${k}`] = v;
    attrs['trae.svr.scope'] = 'turn 级聚合，非本次迭代独有';
  }

  // ---- 输入 / 输出消息在 fillLlmMessages 里回填（需要已建好的 TOOL span）----

  // 末次迭代产出面向用户的最终回答：Stop hook 的思考过程 / 正文 / usage 挂在这里
  const response = round.final ? shared.response : null;
  if (response) {
    const parts = [];
    if (response.reasoning) parts.push({ type: 'reasoning', content: response.reasoning });
    if (response.responseText) parts.push({ type: 'text', content: response.responseText });
    if (parts.length > 0) {
      // 最终轮的回答消息；如果本轮还发了工具，fillLlmMessages 会把工具调用消息拼在它前面
      attrs['gen_ai.output.messages'] = [
        { role: 'assistant', parts, finish_reason: response.finishReason || 'stop' },
      ];
      attrs['trae.output.provenance'] = 'hook:Stop 已补齐最终回答';
      attrs['trae.output.complete'] = true;
    }
    if (response.finishReason) attrs['gen_ai.response.finish_reasons'] = [response.finishReason];
    if (response.usage?.input != null) attrs['gen_ai.usage.input_tokens'] = response.usage.input;
    if (response.usage?.output != null) attrs['gen_ai.usage.output_tokens'] = response.usage.output;
    if (response.usage?.total != null) attrs['gen_ai.usage.total_tokens'] = response.usage.total;
  }

  // usage 本地确实拿不到，把原因写死在 span 上，避免下游当成采集遗漏
  if (attrs['gen_ai.usage.input_tokens'] == null && attrs['gen_ai.usage.output_tokens'] == null) {
    attrs['trae.usage.availability'] = '官方 hook payload 无 usage；日志的 token_count 属于 WebSearch 网页抓取，不是 LLM 用量';
  }

  const llmSpan = span(
    'LLM',
    `chat ${turn.model.requestModel || 'unknown'}`,
    round.llmStartMs,
    round.llmEndMs,
    attrs,
  );
  if (ttft) llmSpan.events = [{ name: 'llm.first_token', atMs: ttft }];
  return llmSpan;
}

/** 从 commit 载荷抽出的工具结果里取一条匹配的（同名 + 提交时刻紧随工具完成） */
function takeToolResult(pool, tool) {
  const hit = pool.find(r => !r.used
    && r.name === tool.name
    && r.atMs >= tool.endMs - RESULT_MATCH_TOLERANCE_MS);
  if (!hit) return null;
  hit.used = true;
  return hit;
}

/**
 * 把一次 WebSearch 的内部行为（查询词 / 命中数 / 逐页抓取）挂到工具 span 上。
 *
 * 对号依据【实测】：搜索记录的 `all steps completed: total_elapsed=T` 与工具的
 * `Run tool WebSearch finished, cost: T` 同值（误差 0~2ms），且前者时刻紧邻在后者之前。
 * 所以拿「cost 相符 + 收尾时刻最近」做唯一匹配，并从池里领走。
 *
 * ⚠️ 不能改回“时间窗内的抓取都算我的”：实测一次推理会并发下发 4 个 WebSearch，
 * 区间两两重叠，那样会把前一次的 5 页算到后一次头上（曾报成 10 页）。
 */
function attachWebSearch(toolSpan, attrs, tool, shared) {
  const pool = shared.searchPool || [];
  const cands = pool.filter(s => !s.used
    && s.doneAtMs != null
    && Math.abs((s.totalElapsedMs ?? -1) - tool.costMs) <= SEARCH_COST_TOLERANCE_MS
    && Math.abs(s.doneAtMs - tool.endMs) <= SEARCH_COST_TOLERANCE_MS);
  const rec = cands.sort((a, b) => Math.abs(a.doneAtMs - tool.endMs) - Math.abs(b.doneAtMs - tool.endMs))[0];
  if (!rec) {
    attrs['trae.websearch.availability'] = '未匹配到 SearchService 记录（日志被轮转或该次搜索未走 search_by_keywords）';
    return;
  }
  rec.used = true;

  // 查询词就是 LLM 下发的工具参数。hook 未配置时这是唯一来源，
  // 所以只在参数还空着时回填，不去覆盖 hook 拿到的原始 JSON。
  if (rec.query) {
    attrs['trae.websearch.query'] = rec.query;
    if (attrs['gen_ai.tool.call.arguments'] == null) {
      attrs['gen_ai.tool.call.arguments'] = JSON.stringify({ query: rec.query });
      attrs['trae.arguments.source'] = 'ai-agent WebSearchDomainFilter stage=tool_entry';
    }
  }
  attrs['trae.websearch.search_api_ms'] = rec.step1Ms ?? null;
  attrs['trae.websearch.fetch_ms'] = rec.step2Ms ?? null;
  attrs['trae.websearch.references'] = rec.referencesCount;
  attrs['trae.websearch.fetch_targets'] = rec.targetCount;
  attrs['trae.websearch.fetched_pages'] = rec.fetches.length;
  attrs['trae.websearch.total_content_tokens'] = rec.fetches.reduce((s, w) => s + (w.tokenCount || 0), 0);

  // 抓了 0 页有两种截然不同的原因，得分开说，否则会被当成采集漏洞去查。
  if (rec.fetches.length === 0) {
    attrs['trae.websearch.empty_reason'] = rec.referencesCount === 0
      ? '搜索无命中（references_count=0），故无网页可抓'
      : `命中 ${rec.referencesCount} 条但抓取目标为 ${rec.targetCount}，无远程抓取上报`;
  }
  if (rec.unmatchedFetch) attrs['trae.websearch.unmatched_fetch'] = true;

  if (rec.fetches.length > 0) {
    toolSpan.events = rec.fetches.map(w => ({
      name: 'web.fetch',
      atMs: w.atMs,
      attributes: {
        'url.full': w.url,
        'http.client.request.duration_ms': w.elapsedMs,
        'trae.fetch.content_length': w.contentLength,
        // 注意：这是**网页内容**的 token 数，不是 LLM 用量
        'trae.fetch.content_tokens': w.tokenCount,
      },
    }));
  }
}

/**
 * 把一个“不在本地执行”的工具还原成它真正的模样。
 *
 * 【实测】派发子智能体时，LLM 下发的工具叫 `search`，但因为
 * `require_local_execution=false`，ToolcallService 把它报成
 * `Run tool no_need_execute finished, status: NoNeedExecute, cost: 0ms`。
 * 直接用这个名字，轨迹上就只能看到一个 0ms 的 `no_need_execute`，
 * 完全看不出“这里把活交给了 Search 子智能体、后面 81 秒都是它在跑”。
 *
 * 本地 0ms 是真实的（客户端只是应了一声“无需本地执行”），所以不拉长
 * span 区间去假装它跑了 81 秒；子智能体的真实耗时当属性 + 事件挂上去，
 * 它自己的工作已经以各自的 STEP / TOOL 存在于时间线上。
 */
function attachDispatch(attrs, tool, shared) {
  const callId = attrs['gen_ai.tool.call.id'];
  const nne = callId ? (shared.noNeedExecutes || []).find(x => x.callId === callId) : null;
  if (!nne) return;

  // 真名覆盖占位名，并把占位名留在旁边以便与日志对得上
  if (nne.toolName && nne.toolName !== tool.name) {
    attrs['gen_ai.tool.name'] = nne.toolName;
    attrs['trae.tool.execute_alias'] = tool.name;
  }
  attrs['trae.tool.local_execution'] = nne.localExecution;

  // 这次不执行是不是因为把活委派给了子智能体
  const sub = (shared.subs || []).find(s => s.parentToolCallId === callId);
  if (!sub) return;
  attrs['gen_ai.tool.type'] = 'subagent';
  attrs['trae.subagent.dispatched'] = sub.agentId;
  attrs['trae.subagent.run_id'] = sub.agentRunId;
  if (sub.status) attrs['trae.subagent.status'] = sub.status;
  if (sub.createMs != null && sub.finishMs != null) {
    attrs['trae.subagent.duration_ms'] = sub.finishMs - sub.createMs;
  }
}

/** 工具执行 → TOOL span */
function buildToolSpan(tool, turn, ctx, shared) {
  const { jobMap, jobsDir, hookIndex } = ctx;
  const end = tool.endMs;
  // 起点优先用日志的 `Start run tool`（毫秒级真实值）；
  // 拿不到才靠 end - cost 反推。注意不能用 state.json 的 started_at 覆盖它：
  // 那个字段是**秒级**的，实测会把 RunCommand 起点提前 354ms，反而盖掉中间的审批相位。
  const observedStart = Number.isFinite(tool.startMs) ? tool.startMs : null;
  let start = observedStart != null ? observedStart : end - (tool.costMs || 0);

  const attrs = {
    'gen_ai.span.kind': 'TOOL',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': tool.name,
    'tool.result.status': normalizeToolStatus(tool.status),
    'tool.result.duration_ms': tool.costMs,
    'trae.tool.outcome': tool.outcome,
    'trae.start_estimated': observedStart == null,
  };
  if (observedStart != null) attrs['trae.time.source'] = 'ai-agent Start run tool';

  // 工具归哪个 agent 跑（主 / 子智能体）。不标的话子智能体的工具会看起来
  // 就是主智能体自己干的（实测一轮里 30 个工具全被记到主智能体头上）。
  applyRunScope(attrs, tool.agentRunId ? shared.runScope?.get(tool.agentRunId) : null);

  // LLM 下发的 call_xxx 是 `gen_ai.tool.call.id` 的权威来源（来自
  // `[execute_toolcall]`，由 attachToolCallIds 按同名工具的第 k 次对号）。
  // 先在这里定下基础值，后面 commit 载荷 / hook 只做确认与补充。
  if (tool.callId) attrs['gen_ai.tool.call.id'] = tool.callId;

  // 派发子智能体的工具——不在本地执行，所以 ToolcallService 只能报成
  // `no_need_execute`，真名（实测 `search`）只在 SSE 路由行里。
  // 不换名的话，轨迹上根本看不出“这里把活交给了 Search 子智能体”。
  attachDispatch(attrs, tool, shared);

  if (tool.name === 'RunCommand' && shared.cmdQueue.length > 0) {
    const cmd = shared.cmdQueue.shift();
    const job = cmd.jobId ? jobMap.get(cmd.jobId) : null;
    const artifacts = cmd.jobId ? readJobArtifacts(jobsDir, cmd.jobId) : null;

    attrs['trae.command.id'] = cmd.jobId || null;
    // ⚠️ 这是 TRAE **内部**的 toolcall id（24 位 hex，形如 6a82c1a9e5152afe53a96182），
    // 与 LLM 下发的 call_xxx 不是同一个东西。早前把它当成 gen_ai.tool.call.id
    // 写进去过，导致 RunCommand 的 call id 与日志不一致。
    attrs['trae.command.toolcall_id'] = cmd.toolcallId || null;

    if (job) {
      attrs['trae.command.exit_code'] = job.exitCode;
      attrs['trae.command.duration_ms'] = job.durationMs;
      attrs['trae.command.monitor_status'] = job.monitorStatus;
    }
    const state = artifacts && artifacts.state;
    if (state) {
      attrs['gen_ai.tool.call.arguments'] = state.command || cmd.commandText || null;
      attrs['trae.command.status'] = state.status;
      attrs['trae.command.exit_code'] = state.exit_code;
      attrs['workspace.path'] = state.cwd || (artifacts && artifacts.cwd) || null;
      // state.json 的 started_at/finished_at 是**秒级**的，只在日志拿不到真实起点时用，
      // 否则会把毫秒级的真值覆盖成粗粒度值（实测提前 354ms）。
      if (observedStart == null && state.started_at && state.finished_at) {
        start = state.started_at * 1000;
        attrs['trae.start_estimated'] = false;
        attrs['trae.time.source'] = 'toolhost state.json（秒级）';
      }
    } else if (cmd.commandText) {
      attrs['gen_ai.tool.call.arguments'] = cmd.commandText;
    }

    if (artifacts && artifacts.output != null) {
      attrs['gen_ai.tool.call.result'] = artifacts.output;
      attrs['trae.result.truncated'] = artifacts.outputTruncated;
      attrs['trae.result.total_bytes'] = artifacts.outputTotalBytes;
      attrs['trae.result.source'] = 'toolhost jobs/output.log';
    }
  }

  // 非 RunCommand 工具的结果：ai-agent 提交回服务端的 toolcall_resp 是本地唯一来源
  if (attrs['gen_ai.tool.call.result'] == null) {
    const submitted = takeToolResult(shared.resultPool, tool);
    if (submitted) {
      attrs['gen_ai.tool.call.result'] = submitted.result;
      if (submitted.toolcallId) attrs['gen_ai.tool.call.id'] = submitted.toolcallId;
      attrs['trae.result.source'] = 'ai-agent commit_toolcall_result';
    } else {
      attrs['gen_ai.tool.call.result'] = null;
      // 内部工具不是「配了 hook 就能补」，得区分开，否则会让人去查不存在的采集漏洞
      attrs['trae.result.availability'] = INTERNAL_TOOLS.has(tool.name)
        ? 'TRAE 内部工具 — 不触发 hook，无结果可采'
        : 'skeleton — 需 PostToolUse hook 补齐';
    }
  }

  // hook 事件若已捕获，用它补齐参数/结果（覆盖上面的推断）
  const hookHit = hookIndex.matchTool(tool.name, start, end, tool.callId);
  if (hookHit) {
    if (hookHit.arguments !== undefined) attrs['gen_ai.tool.call.arguments'] = hookHit.arguments;
    if (hookHit.result !== undefined) attrs['gen_ai.tool.call.result'] = hookHit.result;
    attrs['trae.result.source'] = 'hook:' + hookHit.events.join('+');
    attrs['trae.result.availability'] = 'hook 已补齐';
    // 精确 join 还是降级到时间窗，直接标出来——后者在同轮重复调用同名工具时可能串位
    attrs['trae.hook.matched_by'] = hookHit.matchedBy;
    if (hookHit.sessionId) attrs['gen_ai.conversation.id'] = hookHit.sessionId;
    if (hookHit.toolCallId) attrs['gen_ai.tool.call.id'] = hookHit.toolCallId;
    if (hookHit.status) attrs['tool.result.status'] = normalizeToolStatus(hookHit.status);
    if (hookHit.statusSource) attrs['trae.hook.status_source'] = hookHit.statusSource;
    if (hookHit.exitCode !== undefined) attrs['trae.command.exit_code'] = hookHit.exitCode;
  }

  const toolSpan = span('TOOL', `execute_tool ${attrs['gen_ai.tool.name']}`, start, end, attrs);

  // 联网搜索：把本次调用的查询词与逐页抓取挂上去。
  // 否则一个数秒的 WebSearch 内部完全是黑箱，看不出它搜了什么、拉了哪些网页。
  if (tool.name === 'WebSearch') attachWebSearch(toolSpan, attrs, tool, shared);

  // 这个工具是否被拦下来等人工确认。靠 call_xxx 对号（确认日志行不带 trace_id），
  // 等待区间在工具真正开跑**之前**，所以不在 span 区间内，只作为属性标注。
  const wait = shared.confirmByCallId.get(attrs['gen_ai.tool.call.id']);
  if (wait) {
    attrs['trae.confirm.required'] = true;
    attrs['trae.confirm.reason'] = wait.reason;
    attrs['trae.confirm.wait_ms'] = wait.endMs - wait.beginMs;
  }

  if (tool.status === 'Failed') toolSpan.status = 'ERROR';
  else if (tool.status === 'Running') toolSpan.status = 'UNSET';
  else toolSpan.status = 'OK';

  // Running 只表示「异步下发已返回」，真实成败看 toolhost 的 exit_code。
  // 拿到 exit_code 后必须据此改写状态，否则成功的命令会永远停在 UNSET。
  const exitCode = attrs['trae.command.exit_code'];
  if (typeof exitCode === 'number') {
    toolSpan.status = exitCode === 0 ? 'OK' : 'ERROR';
    attrs['trae.status.source'] = 'toolhost exit_code';
  }
  return toolSpan;
}
