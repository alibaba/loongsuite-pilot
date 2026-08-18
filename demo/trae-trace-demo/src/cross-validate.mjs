/**
 * 交叉校验：把构建出的 trace 与**原始数据源**逐项比对，验证准确性。
 *
 * 与 check-structure.mjs / audit-coverage.mjs 的区别：
 * - check-structure  只看 span 层级是否合法
 * - audit-coverage   只看时间上有没有漏掉过程
 * - 本文件           看**内容是否被搬对了**：名字、顺序、耗时、ID 配对有没有串位
 *
 * 关键点：这里**不复用** parse-agent-log.mjs / parse-hook-events.mjs，
 * 而是用独立的极简正则重新从日志和 hook JSONL 提取真值。
 * 复用同一个解析器交叉校验等于自证，解析器错了会一起错。
 *
 * 用法：node src/cross-validate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { buildTrace } from './build-trace.mjs';
import { PILOT_HISTORY_DIR } from './config.mjs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

/** 行首 ISO 时间 + 级别 + 可选 span 路径 + 模块路径，用来切出消息体 */
const HEAD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+\d{2}:\d{2})\s+(?:INFO|WARN|ERROR|DEBUG)\s+(?:[a-z_0-9:]+:\s+)?[a-z_0-9:]+:/;

/**
 * 独立从日志抽真值（只认最必要的几个模式，故意写得比主解析器更笨）。
 *
 * ⚠️ 但“笨”不能笨到不锚定消息体开头：`[commit_toolcall_result]` 那行的 payload
 * 会把工具结果原样回灌进日志，所以被读文件里的文本会伪装成日志行。
 * 第一版正是在这里翻了车：把被读文档里引用的
 * `Run tool SearchCodebase finished, ... cost: 724ms`
 * 当成真实工具，反过来误判正确的 build-trace 漏了工具。
 */
async function groundTruthFromLog(logPath, traceId) {
  const truth = {
    tools: [], llmRequests: [], commits: [], execIds: [],
    // 子智能体交还：一次交还 = 一个 HTTP 流里装了两个 agent 的输出
    subAgentFinishes: [],
    // 不在本地执行的工具：call id → 真名（ToolcallService 只报 no_need_execute）
    dispatchNames: new Map(),
    chatBegin: null, routeEnd: null,
  };
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // 快速护栏，避开对绝大多数行跑正则
    if (!line.includes(traceId)) continue;
    const head = HEAD.exec(line);
    // trace 归属只认**行内最后一个** trace_id：tracing 字段追加在行尾，
    // 而 payload 回灌的内容在中间。光用 line.includes() 会把引用了本 trace_id 的
    // 别的轮次的日志算进来：实测把 6 次 commit 数成了 14 次。
    let tid = null;
    for (const m of line.matchAll(/trace_id="([0-9a-f]{32})"/g)) tid = m[1];
    if (tid !== traceId) continue;
    const atMs = head ? Date.parse(head[1]) : null;
    const msg = head ? line.slice(head[0].length).trimStart() : line;

    const fin = msg.match(/^\[ToolcallService\] Run tool (\S+) (?:finished|failed), status: (\w+), cost: (\d+)ms/);
    if (fin) truth.tools.push({ name: fin[1], status: fin[2], costMs: Number(fin[3]), endMs: atMs });

    const exec = msg.match(/^\[execute_toolcall\] toolcall_id=([^,]*), name=([^,]+),/);
    if (exec && exec[1].trim()) truth.execIds.push({ callId: exec[1].trim(), name: exec[2].trim() });

    // 派发子智能体的工具不在本地跑，ToolcallService 只能报成 no_need_execute，
    // 真名（实测 search）只在 SSE 路由行里。不拿它换回来，“名字与顺序”那道
    // 校验会把正确的构建判成不一致。
    const nne = msg.match(/^\[SSE_routing\] NoNeedExecute: tool_name=([^,]+), toolcall_id=([^,]+),/);
    if (nne) truth.dispatchNames.set(nne[2].trim(), nne[1].trim());

    const saf = msg.match(/^\[SubAgentFinish\] received: agent_run_id=(\S+?), agent_id=([^,]+), toolcall_id=(\S+)/);
    if (saf) truth.subAgentFinishes.push({ agentRunId: saf[1], agentId: saf[2].trim(), toolCallId: saf[3].trim(), atMs });

    const req = msg.match(/^\[HTTPClient\] request url \S*\/api\/agent\/v\d+\/(create_agent_task|commit_toolcall_result)/);
    if (req) truth.llmRequests.push({ kind: req[1], atMs });

    if (msg.startsWith('[commit_toolcall_result] endpoint=')) truth.commits.push(atMs);
    if (truth.chatBegin == null) {
      const m = msg.match(/rs_01_chat_begin=(\d+)/);
      if (m) truth.chatBegin = Number(m[1]);
    }
    if (msg.startsWith('route end:')) truth.routeEnd = atMs;
  }
  return truth;
}

/** 独立从 hook JSONL 抽 tool_call_id → {args, result} 映射 */
function groundTruthFromHooks(sessionId) {
  const map = new Map();
  if (!fs.existsSync(PILOT_HISTORY_DIR)) return map;
  for (const f of fs.readdirSync(PILOT_HISTORY_DIR).filter(x => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(PILOT_HISTORY_DIR, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r['gen_ai.session.id'] !== sessionId) continue;
      const id = r['gen_ai.tool.call.id'];
      if (!id) continue;
      const cur = map.get(id) || { id, name: r['gen_ai.tool.name'] };
      if (r['agent.trae.hook_event_name'] === 'PreToolUse') cur.args = r['gen_ai.tool.call.arguments'];
      if (r['agent.trae.hook_event_name'] === 'PostToolUse') cur.result = r['gen_ai.tool.call.result'];
      map.set(id, cur);
    }
  }
  return map;
}

/**
 * 独立抽 Harness 装配真值（同样不复用主解析器）。
 *
 * 这里故意写得比主解析器更死沉：不做任何“最后一条为准”的状态机，
 * 只把三类落地行往三个集合里扔，最后取并集。主解析器用 Map 覆盖，
 * 如果它把某个技能的状态判错（比如把 fallback 当成失败），两边就会对不上。
 */
async function harnessTruthFromLog(logPath, traceIds) {
  /** traceId -> 真值 */
  const out = new Map();
  for (const t of traceIds) {
    out.set(t, {
      skillsLoaded: new Set(), rosterTotal: null, rosterMembers: null,
      subAgentNames: new Set(), rules: null, memory: null, usageReports: 0,
    });
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // 模型配置转储行里包含整坨工具定义，实测会把 SearchCodebase / TodoWrite
    // 之类的词带进来（单个关键字命中 30 万次），先排掉。
    if (line.includes('model_extra_config') || line.includes('[ModelMgr]')) continue;
    let tid = null;
    for (const m of line.matchAll(/trace_id="([0-9a-f]{32})"/g)) tid = m[1];
    const T = tid && out.get(tid);
    if (!T) continue;
    const head = HEAD.exec(line);
    const msg = head ? line.slice(head[0].length).trimStart() : line;

    // 三种落地方式都算装配成功。⚠️ fallback 那一支是**成功**：
    // ~/.trae-cn/builtin/global/skills/ 里那几个技能磁盘上确实存在。
    let m;
    if ((m = msg.match(/^\[SkillTool\] find_skill_path: found (?:local builtin|global) skill '([^']+)'/))) T.skillsLoaded.add(m[1]);
    if ((m = msg.match(/^\[SkillTool\] find_skill_path: fallback to global path '[^']+' for skill '([^']+)'/))) T.skillsLoaded.add(m[1]);
    // 被门控裁掉的要从已装配里拿掉，否则会多算
    if ((m = msg.match(/^\[SkillTool\] Removed (?:builtin )?(\S+) skill from/))) T.skillsLoaded.delete(m[1].trim());

    if ((m = msg.match(/^\[get_custom_agent_infos\] agent_list built, total_agents=(\d+)/))) T.rosterTotal = Number(m[1]);
    if ((m = msg.match(/^\[get_custom_agent_infos\] got root_agent, members_count=(\d+)/))) T.rosterMembers = Number(m[1]);
    if ((m = msg.match(/^\[get_custom_agent_infos\] fetching sub_agent: (\S+)/))) T.subAgentNames.add(m[1].trim());
    if ((m = msg.match(/^\[RawRules\] global_rules=(\d+), project_rules_types=\[([^\]]*)\], should_mask=(\w+)/))) {
      T.rules = { globalCount: Number(m[1]), typesRaw: m[2].trim(), shouldMask: m[3] === 'true' };
    }
    if ((m = msg.match(/^\[create_agent_task\] enable_chat_memory_user_config=Some\((\w+)\), enable_core_memory=(\w+)/))) {
      T.memory = { chat: m[1] === 'true', core: m[2] === 'true' };
    }
    if (msg.startsWith('[ContextUsage] received from cloud:')) T.usageReports++;
  }
  return out;
}

function flatten(root, out = []) {
  out.push(root);
  for (const c of root.children || []) flatten(c, out);
  return out;
}

const stable = v => (v == null ? null : JSON.stringify(v));

const built = await buildTrace();
if (!built.ok) {
  console.error('构建失败:', built.reason || built);
  process.exit(1);
}
const turn = built.traces[0];
if (!turn) {
  console.error('没有轮次可校验');
  process.exit(1);
}

// 日志文件用构建器已解析确认的那份（开多个 TRAE 窗口时每个窗口各一份日志目录，
// 自己再猜一遍只会猜错）。独立性体现在**解析逻辑**不复用，而不在文件发现。
// 代价是选错文件时真值会全 0，所以下面单独查一道“真值非空”——
// 否则 0 vs 0 会以“一致”的形式静默通过。
const truth = await groundTruthFromLog(built.sources.agentLog, turn.traceId);
const hookTruth = groundTruthFromHooks(built.sessionId);

const spans = flatten(turn.root);
const llmSpans = spans.filter(s => s.kind === 'LLM');
const toolSpans = spans.filter(s => s.kind === 'TOOL');

console.log(`session ${built.sessionId}`);
console.log(`trace   ${turn.traceId}`);
console.log(`\n原始日志真值：${truth.tools.length} 个工具 · ${truth.llmRequests.length} 次服务端请求 · ${truth.commits.length} 次 commit · ${truth.execIds.length} 个 call_id`);
console.log(`hook 真值：  ${hookTruth.size} 个 tool_call_id`);
console.log(`构建结果：  ${toolSpans.length} 个 TOOL span · ${llmSpans.length} 个 LLM span`);

// 0. 真值本身得非空。否则下面每一道“建构 0 vs 日志 0”都会以一致的形式通过，
// 等于什么也没校。实测踩过：抽真值时读错了日志文件，全 0 的真值把一个
// 完全正确的 trace 判成“多造了 10 个工具”。
check('ground_truth_non_empty',
  truth.tools.length > 0 && truth.llmRequests.length > 0,
  truth.tools.length > 0 && truth.llmRequests.length > 0
    ? ''
    : `日志 ${built.sources.agentLogDir} 里没抽到 trace ${turn.traceId} 的任何真值`);

// 1. LLM 调用次数 == 服务端请求数 + 子智能体交还数
// 【实测】“1 个 HTTP 请求 = 1 次推理”在子智能体**交还处不成立**：服务端把
// “子智能体汇报 + 交还 + 主智能体继续输出”复用了同一个响应流（那个流的
// `plan final token cost: 43533ms` 反推起点正好是上一次 commit）。
// 所以每次交还会多出一段属于另一个 agent 的输出，应建成独立的 LLM span。
const expectedLlm = truth.llmRequests.length + truth.subAgentFinishes.length;
check('llm_count_matches_requests',
  llmSpans.length === expectedLlm,
  `构建 ${llmSpans.length} vs 日志 ${truth.llmRequests.length} 请求 + ${truth.subAgentFinishes.length} 次子智能体交还`);

// 2. 请求数 == 1 + commit 数（验证「每个 commit 的响应就是下一次流」这条规则本身）
check('requests_equal_1_plus_commits',
  truth.llmRequests.length === truth.commits.length + 1,
  `请求 ${truth.llmRequests.length} vs commit ${truth.commits.length}+1`);

// 3. 工具数量与「名字 + 顺序」完全一致
const builtNames = toolSpans.map(s => s.attributes['gen_ai.tool.name']);
// 日志侧把“不在本地执行”的工具报成了占位名，先用 SSE 路由行换回真名。
// Run tool 行不带 call id，所以靠 execute_toolcall 里**同名工具的第 k 次**对号。
let nneSeen = 0;
const dispatchExecIds = truth.execIds.filter(e => e.name === 'no_need_execute');
const truthNames = truth.tools.map(t => {
  if (t.name !== 'no_need_execute') return t.name;
  const e = dispatchExecIds[nneSeen++];
  return (e && truth.dispatchNames.get(e.callId)) || t.name;
});
check('tool_count_matches', builtNames.length === truthNames.length,
  `构建 ${builtNames.length} vs 日志 ${truthNames.length}`);
check('tool_names_and_order_match',
  builtNames.join('>') === truthNames.join('>'),
  builtNames.join('>') === truthNames.join('>') ? '' : `\n        构建: ${builtNames.join(' > ')}\n        日志: ${truthNames.join(' > ')}`);

// 4. 每个工具的耗时与日志 cost 一致
const durMismatch = [];
toolSpans.forEach((s, i) => {
  const t = truth.tools[i];
  if (!t) return;
  if (s.attributes['tool.result.duration_ms'] !== t.costMs) {
    durMismatch.push(`${t.name}: span ${s.attributes['tool.result.duration_ms']} vs log ${t.costMs}`);
  }
});
check('tool_duration_matches_log', durMismatch.length === 0, durMismatch.join('; '));

// 5. 每个工具的 call_id 与日志 execute_toolcall 的同名第 k 次一致
const idPool = new Map();
for (const e of truth.execIds) {
  if (!idPool.has(e.name)) idPool.set(e.name, []);
  idPool.get(e.name).push(e.callId);
}
const usedK = new Map();
const idMismatch = [];
for (const s of toolSpans) {
  const name = s.attributes['gen_ai.tool.name'];
  const k = usedK.get(name) || 0;
  usedK.set(name, k + 1);
  const expected = (idPool.get(name) || [])[k];
  const actual = s.attributes['gen_ai.tool.call.id'];
  if (expected && actual !== expected) idMismatch.push(`${name}#${k + 1}: ${actual} ≠ ${expected}`);
}
check('tool_call_id_matches_log', idMismatch.length === 0, idMismatch.join('; '));

// 6. 最关键：span 上的参数/结果必须来自**同一个 tool_call_id** 的 hook 记录（查串位）
const contentMismatch = [];
let verified = 0;
for (const s of toolSpans) {
  const id = s.attributes['gen_ai.tool.call.id'];
  const h = id ? hookTruth.get(id) : null;
  if (!h) continue;
  verified++;
  if (h.args !== undefined && stable(s.attributes['gen_ai.tool.call.arguments']) !== stable(h.args)) {
    contentMismatch.push(`${h.name}(${id.slice(0, 14)}) 参数不符`);
  }
  if (h.result !== undefined && stable(s.attributes['gen_ai.tool.call.result']) !== stable(h.result)) {
    contentMismatch.push(`${h.name}(${id.slice(0, 14)}) 结果不符`);
  }
}
check('span_content_belongs_to_same_call_id', contentMismatch.length === 0,
  contentMismatch.length ? contentMismatch.join('; ') : `按 call_id 逐项核对 ${verified} 个工具`);

// 7. 同名工具没有共用同一个 call_id（串位的直接症状）
const ids = toolSpans.map(s => s.attributes['gen_ai.tool.call.id']).filter(Boolean);
check('no_duplicate_call_id', new Set(ids).size === ids.length,
  `${ids.length} 个 id，去重后 ${new Set(ids).size}`);

// 8. 轮次边界与日志一致
if (truth.chatBegin) {
  check('entry_start_matches_chat_begin',
    Math.abs(turn.root.startMs - truth.chatBegin) <= 50,
    `span ${turn.root.startMs} vs rs_01 ${truth.chatBegin}（差 ${turn.root.startMs - truth.chatBegin}ms）`);
}
if (truth.routeEnd) {
  check('entry_end_matches_route_end',
    Math.abs(turn.root.endMs - truth.routeEnd) <= 50,
    `span ${turn.root.endMs} vs route end ${truth.routeEnd}（差 ${turn.root.endMs - truth.routeEnd}ms）`);
}

// 9. LLM span 起点与服务端请求时刻一致
//
// 共流的交还 span 要排除：它没有自己的 HTTP 请求，拉进来按下标对会把后面
// 所有轮次都错一位。判断靠构建侧的自报（trae.llm.stream_shared），但自报的
// **个数**要用日志的 SubAgentFinish 数卡住，否则“多报几个共流”就能让这道
// 校验形同虚设。
const sharedSpans = llmSpans.filter(s => s.attributes['trae.llm.stream_shared'] === true);
check('shared_stream_count_matches_handoffs',
  sharedSpans.length === truth.subAgentFinishes.length,
  `自报共流 ${sharedSpans.length} vs 日志交还 ${truth.subAgentFinishes.length}`);

// 共流 span 的起点应等于对应的 SubAgentFinish 时刻（交还才是它开始输出的时刻）
const handoffMismatch = [];
sharedSpans.forEach(s => {
  const near = truth.subAgentFinishes.some(f => Math.abs(s.startMs - f.atMs) <= 5);
  if (!near) handoffMismatch.push(`span ${s.startMs} 不在任何 SubAgentFinish 时刻上`);
});
check('shared_stream_starts_at_handoff', handoffMismatch.length === 0, handoffMismatch.join('; '));

const llmStartMismatch = [];
llmSpans.filter(s => s.attributes['trae.llm.stream_shared'] !== true).forEach((s, i) => {
  const req = truth.llmRequests[i];
  if (!req) return;
  if (Math.abs(s.startMs - req.atMs) > 5) {
    llmStartMismatch.push(`第 ${i + 1} 个非共流 LLM: span ${s.startMs} vs 请求 ${req.atMs}`);
  }
});
check('llm_start_matches_request_time', llmStartMismatch.length === 0, llmStartMismatch.join('; '));

// ---- Harness 装配：逐 trace 校，不只校第一轮 ----
// 上面那些规则只看 traces[0]，但 Harness 必须逐轮看：实测第二轮的
// 云端回执是 0 次而第一轮是 2 次——只校第一轮的话，「0 次」这个分支永远没人验。
const harnessTruth = await harnessTruthFromLog(built.sources.agentLog, built.traces.map(t => t.traceId));
const hErrs = [];
let hSkillTotal = 0;
for (const t of built.traces) {
  const T = harnessTruth.get(t.traceId);
  const a = t.root.children[0].attributes;   // AGENT span
  const tag = t.traceId.slice(0, 8);

  // 技能清单：比**集合**而不是比个数。个数相等很容易在漏一个、
  // 多一个的情况下凑好，那就白校了。
  const builtSkills = [...(a['trae.harness.skills.loaded'] || [])].sort();
  const truthSkills = [...T.skillsLoaded].sort();
  hSkillTotal += truthSkills.length;
  if (stable(builtSkills) !== stable(truthSkills)) {
    hErrs.push(`${tag} 技能清单不符: 构建 ${builtSkills.length} vs 日志 ${truthSkills.length}`);
  }
  // 按来源分的三组加起来必须等于总数，否则就是有技能没被归类
  const grouped = ['builtin_global', 'local_builtin', 'user_global']
    .reduce((n, k) => n + (a[`trae.harness.skills.${k}`] || []).length, 0);
  if (grouped !== builtSkills.length) {
    hErrs.push(`${tag} 技能分组与总数不平: 分组合计 ${grouped} vs 清单 ${builtSkills.length}`);
  }

  // 名册：total_agents 应等于主智能体自己 + 声明的成员数
  if (T.rosterTotal != null && a['trae.harness.roster.total'] !== T.rosterTotal) {
    hErrs.push(`${tag} 名册总数 ${a['trae.harness.roster.total']} vs 日志 ${T.rosterTotal}`);
  }
  if (T.rosterTotal != null && T.rosterTotal !== T.subAgentNames.size + 1) {
    hErrs.push(`${tag} 日志自相矛盾: total_agents=${T.rosterTotal} 但只 fetch 了 ${T.subAgentNames.size} 个成员`);
  }

  // 规则：数量与脱敏开关逐项对
  if (T.rules) {
    if (a['trae.harness.rules.global_count'] !== T.rules.globalCount) hErrs.push(`${tag} 全局规则数不符`);
    if (a['trae.harness.rules.should_mask'] !== T.rules.shouldMask) hErrs.push(`${tag} should_mask 不符`);
    // 0 条规则就必须是 0 字符。不卡这一手，“规则数 0 / 注入 3000 字符”
    // 这种自相矛盾就会混过去。
    const types = a['trae.harness.rules.project_types'] || [];
    if (T.rules.globalCount === 0 && types.length === 0 && a['trae.harness.rules.injected_chars'] !== 0) {
      hErrs.push(`${tag} 0 条规则却报注入 ${a['trae.harness.rules.injected_chars']} 字符`);
    }
  }

  // 记忆开关
  if (T.memory) {
    if (a['trae.harness.memory.chat_enabled'] !== T.memory.chat) hErrs.push(`${tag} chat_memory 开关不符`);
    if (a['trae.harness.memory.core_enabled'] !== T.memory.core) hErrs.push(`${tag} core_memory 开关不符`);
  }

  // 云端回执次数。实测第二轮为 0，而 0 次时**不得**写 environment_used：
  // 写了 false 会被读成「环境上下文没被用」，而真相是「云端没回执」。
  if (a['trae.harness.context.usage_report_count'] !== T.usageReports) {
    hErrs.push(`${tag} 云端回执次数 ${a['trae.harness.context.usage_report_count']} vs 日志 ${T.usageReports}`);
  }
  if (T.usageReports === 0 && 'trae.harness.context.environment_used' in a) {
    hErrs.push(`${tag} 无云端回执却报了 environment_used（会被误读成“没用上”）`);
  }
}
// 真值非空：技能全抽不到时，上面每一项都会以「空 == 空」静默通过。
check('harness_ground_truth_non_empty', hSkillTotal > 0, hSkillTotal > 0 ? '' : '日志里没抽到任何技能装配行');
check('harness_matches_log', hErrs.length === 0, hErrs.join('; ') || `${built.traces.length} 轮均一致`);

console.log('\n交叉校验（真值来自原始日志 + hook JSONL，未复用主解析器）');
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
}
console.log(failed ? `\n${failed} 项不一致` : '\n全部一致');
process.exit(failed ? 1 : 0);
