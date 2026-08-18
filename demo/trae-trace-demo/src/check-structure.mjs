/**
 * 结构校验：把 demo 合成的 span 树按 scripts/validate-trace.mjs 的强制规则逐条过一遍。
 *
 * 为什么单独写一份而不直接调 validate-trace.mjs：后者吃的是 pilot JSONL 输出格式
 * （resourceSpans / scopeSpans），本 demo 产出的是内存里的 span 树。规则语义严格对齐
 * validate-trace.mjs 第 196-279 行，改那边的规则时这里要跟着改。
 *
 * 用法：node src/check-structure.mjs
 */
import { buildTrace } from './build-trace.mjs';

const RULES = [];
function check(name, ok, detail = '') {
  RULES.push({ name, ok, detail });
}

/** 展平 span 树，附带父节点 kind */
function flatten(root, parentKind = null, out = []) {
  out.push({ span: root, parentKind });
  for (const c of root.children || []) flatten(c, root.kind, out);
  return out;
}

function validateTurn(turn, idx) {
  const flat = flatten(turn.root);
  const byKind = k => flat.filter(x => x.span.kind === k);

  const entries = byKind('ENTRY');
  check(`turn${idx}.single_entry`, entries.length === 1, `${entries.length} ENTRY`);
  check(`turn${idx}.entry_is_root`, entries.length === 1 && entries[0].parentKind === null);

  const agents = byKind('AGENT');
  check(`turn${idx}.single_agent`, agents.length === 1, `${agents.length} AGENT`);
  check(`turn${idx}.agent_under_entry`, agents.every(a => a.parentKind === 'ENTRY'));

  const steps = byKind('STEP');
  check(`turn${idx}.step_under_agent`,
    steps.length > 0 && steps.every(s => s.parentKind === 'AGENT' || s.parentKind === 'SUBAGENT'),
    `${steps.length} STEP`);

  const subagents = byKind('SUBAGENT');
  if (subagents.length > 0) {
    check(`turn${idx}.subagent_under_agent`,
      subagents.every(s => s.parentKind === 'AGENT'),
      `${subagents.length} SUBAGENT`);
  }

  const llms = byKind('LLM');
  check(`turn${idx}.llm_under_step`,
    llms.length > 0 && llms.every(l => l.parentKind === 'STEP'),
    `${llms.length} LLM`);

  const tools = byKind('TOOL');
  check(`turn${idx}.tool_under_step`,
    tools.every(t => t.parentKind === 'STEP'),
    `${tools.length} TOOL`);

  // 每个 STEP 恰好 1 个 LLM —— 这是最容易踩的一条
  const badSteps = steps.filter(
    s => (s.span.children || []).filter(c => c.kind === 'LLM').length !== 1,
  );
  check(`turn${idx}.step_has_one_llm`, badSteps.length === 0,
    badSteps.length ? badSteps.map(s =>
      `${s.span.name}:${(s.span.children || []).filter(c => c.kind === 'LLM').length}`).join(',')
      : `${steps.length} STEP 各含 1 个 LLM`);

  // STEP 内 LLM 必须不晚于所有 TOOL 起点
  const outOfOrder = [];
  for (const s of steps) {
    const kids = s.span.children || [];
    const llm = kids.find(c => c.kind === 'LLM');
    if (!llm) continue;
    for (const t of kids.filter(c => c.kind === 'TOOL')) {
      if (t.startMs < llm.startMs) outOfOrder.push(`${t.name}(${llm.startMs - t.startMs}ms 早于 LLM)`);
    }
  }
  check(`turn${idx}.llm_before_tools`, outOfOrder.length === 0, outOfOrder.join(', '));

  // 子 span 时间窗必须落在父 span 内
  const escaped = [];
  for (const { span, parentKind: pk } of flat) {
    if (!pk) continue;
    const parent = flat.find(x => (x.span.children || []).includes(span));
    if (!parent) continue;
    if (span.startMs < parent.span.startMs || span.endMs > parent.span.endMs) {
      escaped.push(`${span.kind} ${span.name}`);
    }
  }
  check(`turn${idx}.child_within_parent`, escaped.length === 0, escaped.join(', '));

  return { steps: steps.length, tools: tools.length, llms: llms.length };
}

/** 内容完整性：用户 prompt / 工具参数 / 工具结果 / 最终回答是否真的在 span 里 */
function reportContent(turn, idx) {
  const flat = flatten(turn.root);
  const entry = flat.find(x => x.span.kind === 'ENTRY').span;
  const tools = flat.filter(x => x.span.kind === 'TOOL').map(x => x.span);
  const llms = flat.filter(x => x.span.kind === 'LLM').map(x => x.span);

  const hasPrompt = entry.attributes['gen_ai.input.messages'] != null;
  const answered = llms.some(l => l.attributes['gen_ai.output.messages'] != null);

  const real = tools.filter(t => t.attributes['trae.result.availability'] !== undefined
    ? !String(t.attributes['trae.result.availability']).startsWith('TRAE 内部工具')
    : true);
  const withArgs = real.filter(t => t.attributes['gen_ai.tool.call.arguments'] != null);
  const withResult = real.filter(t => t.attributes['gen_ai.tool.call.result'] != null);
  const exactJoin = real.filter(t => t.attributes['trae.hook.matched_by'] === 'tool_call_id');
  const fuzzyJoin = real.filter(t => t.attributes['trae.hook.matched_by'] === 'name+time_window');

  console.log(`\n内容完整性（turn ${idx}）`);
  console.log(`  用户 prompt        ${hasPrompt ? '✅' : '❌'}`);
  console.log(`  助手最终回答       ${answered ? '✅' : '❌'}`);
  console.log(`  工具参数           ${withArgs.length}/${real.length}`);
  console.log(`  工具结果           ${withResult.length}/${real.length}`);
  console.log(`  精确 join(call_id) ${exactJoin.length}/${real.length}${fuzzyJoin.length ? `  ⚠️ ${fuzzyJoin.length} 个降级到时间窗` : ''}`);
  const internal = tools.length - real.length;
  if (internal > 0) console.log(`  内部工具(无结果)   ${internal} 个，属预期`);
}

const result = await buildTrace();
if (!result.ok) {
  console.error('构建失败:', result.reason || result);
  process.exit(1);
}

console.log(`session ${result.sessionId}  轮次 ${result.traces.length}  hook 事件 ${result.sources.hookEventsCount}`);

result.traces.forEach((t, i) => {
  const st = validateTurn(t, i + 1);
  console.log(`\nturn ${i + 1}  trace=${t.traceId}  ${st.steps} STEP / ${st.llms} LLM / ${st.tools} TOOL`);
  reportContent(t, i + 1);
});

console.log('\n结构校验（对齐 scripts/validate-trace.mjs）');
let failed = 0;
for (const r of RULES) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(failed ? `\n${failed} 条规则不通过` : '\n全部规则通过');
process.exit(failed ? 1 : 0);
