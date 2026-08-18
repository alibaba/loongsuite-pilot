/**
 * 覆盖率审计：回答「这一轮到底还有多少过程没进轨迹」。
 *
 * 结构校验（check-structure.mjs）只保证已建出来的 span 内部自洽，
 * 不保证没漏掉过程——这两件事必须分开验。本工具做三件事：
 *
 * 1. 壁钟覆盖率：轮次总时长里，有多少落在叶子 span（LLM / TOOL）内，多少是空白窗口
 * 2. 空白窗口定位：把每段空白与该时段的 span event / 日志相位对上，说明它是什么
 * 3. 已知不可得项清单：本地根本拿不到的内容（服务端构建的 prompt、思考过程、token 用量）
 *
 * 用法：node src/audit-coverage.mjs
 */
import { buildTrace } from './build-trace.mjs';

/** 空白窗口小于此值视为噪声（相邻 span 的毫秒级缝隙），不单独报告 */
const GAP_NOISE_MS = 50;

function flatten(root, out = []) {
  out.push(root);
  for (const c of root.children || []) flatten(c, out);
  return out;
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

/**
 * 区间事件的时长（毫秒），不是区间事件则返回 null。
 *
 * “点事件”只能证明某一瞬间在干什么；“区间事件”能证明一整段壁钟被什么占用了。
 * 两类目前都是“不属于 Agent 本身”的成本：采集器 hook 阻塞、等用户确认。
 */
const INTERVAL_EVENT_KEYS = ['pilot.hook.duration_ms', 'trae.confirm.wait_ms'];
function intervalMs(event) {
  const attrs = event.attributes || {};
  for (const k of INTERVAL_EVENT_KEYS) {
    if (Number.isFinite(attrs[k])) return attrs[k];
  }
  return null;
}

function auditTurn(turn, idx) {
  const all = flatten(turn.root);
  const root = turn.root;
  const total = root.durationMs;

  // 叶子 span = 真正代表「在干活」的区间；容器 span（ENTRY/AGENT/STEP）不计，否则覆盖率恒 100%
  const leaves = all.filter(s => s.kind === 'LLM' || s.kind === 'TOOL');

  // 合并叶子区间（LLM 与其并发工具会重叠，不能直接累加时长）
  const merged = [];
  for (const s of leaves.slice().sort((a, b) => a.startMs - b.startMs)) {
    const last = merged[merged.length - 1];
    if (last && s.startMs <= last.end) last.end = Math.max(last.end, s.endMs);
    else merged.push({ start: s.startMs, end: s.endMs });
  }
  const covered = merged.reduce((sum, r) => sum + (r.end - r.start), 0);

  // 空白窗口：轮次范围内不被任何叶子覆盖的部分
  const gaps = [];
  let cursor = root.startMs;
  for (const r of merged) {
    if (r.start - cursor > GAP_NOISE_MS) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (root.endMs - cursor > GAP_NOISE_MS) gaps.push({ start: cursor, end: root.endMs });

  const agent = all.find(s => s.kind === 'AGENT');
  const events = (agent && agent.events) || [];

  console.log(`\n── Turn ${idx}  ${turn.traceId}  总时长 ${fmt(total)}`);
  console.log(`   叶子 span 覆盖 ${fmt(covered)}  (${((covered / total) * 100).toFixed(1)}%)`);
  console.log(`   未覆盖空白   ${fmt(total - covered)}  (${(((total - covered) / total) * 100).toFixed(1)}%)，分 ${gaps.length} 段`);

  for (const g of gaps) {
    const dur = g.end - g.start;
    // 点时刻事件：落在窗口内即算交代。
    const inWindow = events.filter(e => e.atMs >= g.start - 5 && e.atMs <= g.end + 5);
    // 区间事件（采集器 hook 开销 / 等用户确认）：只要与空白**重叠**就算交代，
    // 因为它真实占用了这段壁钟（TRAE 同步阻塞等 hook 返回；确认则是在等人）。
    const overlaps = events.filter(e => {
      const d = intervalMs(e);
      return d != null && e.atMs < g.end && e.atMs + d > g.start;
    });
    const rel = ms => `+${ms - root.startMs}ms`;
    console.log(`\n   空白 ${rel(g.start)} → ${rel(g.end)}  (${fmt(dur)})`);
    // 两类证据都报出来：区间事件的实际覆盖 + 点事件的描述。
    // 【警示】旧版用 else-if 让区间事件過早截断，导致 527ms 的 hook 就可以「交代」
    // 35.3s 的空白，里面的子智能体相位标记永远不会被报出——现在改成并列打印，
    // 并用「剩余无交代」单独计算。
    let explained = false;
    if (overlaps.length > 0) {
      const covMs = overlaps.reduce((s, e) => {
        const d = intervalMs(e);
        return s + (Math.min(e.atMs + d, g.end) - Math.max(e.atMs, g.start));
      }, 0);
      const kinds = [...new Set(overlaps.map(e => e.name.split(':')[0]))].join(' + ');
      console.log(`     ✅ 已交代：${kinds} 占用 ${fmt(covMs)}（${overlaps.length} 段）`);
      explained = true;
    }
    if (inWindow.length > 0) {
      console.log(`     ✅ 已交代：${inWindow.length} 个 span event`);
      console.log(`        ${inWindow.map(e => e.name).join(' → ')}`);
      explained = true;
    }
    if (!explained) {
      console.log('     ⚠️ 无任何 span event 交代——这段时间在轨迹里是纯空白');
    }
  }

  // LLM 侧的观测质量
  console.log('\n   LLM 观测质量：');
  for (const l of all.filter(s => s.kind === 'LLM')) {
    const a = l.attributes;
    const marks = [];
    marks.push(a['trae.llm.start_observed'] ? '起点实测' : '起点推断');
    marks.push(a['trae.llm.ttft_ms'] != null ? `TTFT ${a['trae.llm.ttft_ms']}ms` : 'TTFT 缺失');
    marks.push(a['gen_ai.input.messages'] != null ? '有输入' : '输入不可得');
    marks.push(a['gen_ai.output.messages'] != null ? '有输出' : '输出不可得');
    marks.push(a['gen_ai.usage.input_tokens'] != null ? '有 usage' : 'usage 缺失');
    console.log(`     round ${a['gen_ai.react.round']}  ${fmt(l.durationMs)}  ${marks.join(' | ')}`);
  }

  return { total, covered, gapCount: gaps.length, unexplained: gaps.filter(g => {
    const inWindow = events.filter(e => e.atMs >= g.start - 5 && e.atMs <= g.end + 5);
    const overlaps = events.filter(e => {
      const d = intervalMs(e);
      return d != null && e.atMs < g.end && e.atMs + d > g.start;
    });
    return inWindow.length === 0 && overlaps.length === 0;
  }).length };
}

const result = await buildTrace();
if (!result.ok) {
  console.error('构建失败:', result.reason || result);
  process.exit(1);
}

console.log(`session ${result.sessionId}  轮次 ${result.traces.length}`);
const stats = result.traces.map((t, i) => auditTurn(t, i + 1));

console.log('\n── 本地信号的固有上限（不是采集 bug，改代码也拿不到）');
console.log('   · LLM 输入 messages：prompt 由服务端拼装（svr__02_preprocess_build_llm_prompt），本地只有渲染时刻');
console.log('   · 中间轮次的助手文本 / 思考过程：只在 SSE 流里透传给 UI，不落盘；hook 的 Stop 也只给 last_assistant_message');
console.log('   · token 用量：官方 hook payload 无 usage；日志只有 token_count，input/output 归属未明');
console.log('   · 迭代 2+ 的服务端耗时拆解：TRAE 的 timing 埋点只测本轮首次 LLM 调用，svr_* 仅一组');
console.log('   · 工具之间的毫秒缝隙：部分是采集器自身的 hook 开销（已单独拆出），剩下的是流式接收 / 内部调度');

const unexplained = stats.reduce((n, s) => n + s.unexplained, 0);
console.log(unexplained
  ? `\n⚠️ 仍有 ${unexplained} 段空白无交代，需要补 span event`
  : '\n所有空白窗口均已由 span event 交代');
process.exit(unexplained ? 1 : 0);
