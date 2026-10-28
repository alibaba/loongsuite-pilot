import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span, type SpanContext, type Tracer } from '@opentelemetry/api';
import type { EventLogRecord } from '@loongsuite/otel-util-genai';
import type { NativeAssistantRound, NativeRoundReconstruction } from '../inputs/doubao-work/doubao-work-rounds.js';
import { doubaoDigest, doubaoRootAgentSpanId } from '../inputs/doubao-work/doubao-work-log.js';

interface Interval { start: bigint; end: bigint; status?: string }
export interface RoundPlacement { parent: Span; stepId: string }
interface RoundTimes { start: bigint; llmEnd: bigint; end: bigint; tools: Map<string, Interval> }
const nano = (value: bigint): [number, number] => [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)];
const isTime = (value: unknown): value is string => typeof value === 'string' && /^\d{19}$/.test(value);
const PREFIX = 'loongsuite.doubao_work.';

/** Normal LLM/STEP/TOOL spans from visible assistant batches. Tool intervals
 * remain source-accurate. LLM times are logical estimates between observed
 * request/tool boundaries, not provider inference measurements. Unanchored
 * intermediate boundaries are interpolated, never taken from file mtimes.
 * This deliberately does not manufacture model/usage/response metadata.
 */
export function addDoubaoAssistantRounds(
  owner: Span, records: EventLogRecord[], tracer: Tracer, startNano: string, endNano: string, ownerRecord: EventLogRecord,
): { spanCount: number; placements: Map<string, RoundPlacement> } {
  const empty = () => ({ spanCount: 0, placements: new Map<string, RoundPlacement>() });
  const value = ownerRecord['agent.doubao_work.assistant_rounds'] as NativeRoundReconstruction | undefined;
  if (!value || !Array.isArray(value.rounds) || !value.rounds.length || value.rounds.length > 64) return empty();
  const rounds = value.rounds;
  if (rounds.some(round => typeof round.id !== 'string' || !/^[0-9a-f]{64}$/.test(round.id)
    || !Array.isArray(round.callIds) || !Array.isArray(round.tools)
    || !Array.isArray(round.inputMessages) || !Array.isArray(round.outputMessages)
    || round.tools.length !== round.callIds.length
    || round.tools.some((tool, i) => tool.callId !== round.callIds[i] || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(tool.callId)
      || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(tool.name) || typeof tool.completed !== 'boolean'))) return empty();
  if (new Set(rounds.map(round => round.id)).size !== rounds.length) return empty();
  const callIds = rounds.flatMap(round => round.callIds);
  if (new Set(callIds).size !== callIds.length) return empty();
  const times = estimateRoundTimes(rounds, records, startNano, endNano, ownerRecord);
  if (!times) {
    owner.setAttribute(`${PREFIX}assistant_rounds_not_in_span`, rounds.length);
    return empty();
  }
  if (value.omittedRounds > 0) owner.setAttribute(`${PREFIX}assistant_rounds_omitted`, value.omittedRounds);
  const placements = new Map<string, RoundPlacement>(), parent = owner.spanContext();
  const ownerId = ownerRecord[`${PREFIX}observation_scope`] === 'native_sandbox_execution' ? parent.spanId : doubaoRootAgentSpanId(parent.traceId);
  const localIds = new Set(records.filter(record => ['tool.call', 'tool.result'].includes(String(record['event.name'])))
    .map(record => record['gen_ai.tool.call.id']));
  const common: Attributes = { 'gen_ai.framework': 'doubao-work' };
  for (const key of ['gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.provider.name']) {
    if (typeof ownerRecord[key] === 'string') common[key] = ownerRecord[key] as string;
  }
  if (common['gen_ai.turn.id'] === undefined && typeof ownerRecord[`${PREFIX}root_turn_id`] === 'string') {
    common['gen_ai.turn.id'] = ownerRecord[`${PREFIX}root_turn_id`] as string;
  }
  if (typeof ownerRecord['user.id'] === 'string') common['gen_ai.user.id'] = ownerRecord['user.id'];
  let spanCount = 0;
  let transcriptTools = 0;
  const transcriptToolLimit = Math.max(0, 64 - localIds.size);
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i], time = times[i];
    const stepId = doubaoDigest(`${parent.traceId}:${ownerId}:assistant-step:${round.id}`).slice(0, 16);
    const step = fixedSpan(tracer, 'step', { ...common, 'gen_ai.span.kind': 'STEP', 'gen_ai.operation.name': 'step', 'gen_ai.step.id': stepId }, parent, stepId, time.start);
    const llmId = doubaoDigest(`${parent.traceId}:${ownerId}:assistant-llm:${round.id}`).slice(0, 16);
    const llm = fixedSpan(tracer, 'chat', { ...common, 'gen_ai.span.kind': 'LLM', 'gen_ai.operation.name': 'chat',
      'gen_ai.step.id': stepId, 'gen_ai.input.messages': JSON.stringify(round.inputMessages),
      'gen_ai.output.messages': JSON.stringify(round.outputMessages) }, step.spanContext(), llmId, time.start, SpanKind.CLIENT);
    llm.end(nano(time.llmEnd)); spanCount += 2;
    for (const id of round.callIds) placements.set(id, { parent: step, stepId });
    for (const tool of round.tools) {
      // Native records are exported by the strict native tool path, including
      // its ambiguity checks. Never bypass a rejected native pair via replay.
      if (localIds.has(tool.callId) || !tool.completed || transcriptTools >= transcriptToolLimit) continue;
      const interval = time.tools.get(tool.callId) ?? { start: time.llmEnd, end: time.end };
      const toolId = doubaoDigest(`${parent.traceId}:${ownerId}:transcript-tool:${tool.callId}`).slice(0, 16);
      const failed = interval.status === 'error' || (typeof tool.result === 'string'
        && ['create_agent', 'send_message', 'wait_agent', 'peek_task_progress'].includes(tool.name)
        && tool.result.startsWith(`${tool.name} failed:`));
      const span = fixedSpan(tracer, `execute_tool ${tool.name}`, { ...common,
        'gen_ai.span.kind': 'TOOL', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.name, 'gen_ai.tool.call.id': tool.callId, 'gen_ai.tool.type': 'function',
        ...(tool.arguments === undefined ? {} : { 'gen_ai.tool.call.arguments': JSON.stringify(tool.arguments) }),
        ...(tool.result === undefined ? {} : { 'gen_ai.tool.call.result': tool.result }),
        ...(failed ? { 'error.type': 'doubao.tool_failed' } : {}),
      }, step.spanContext(), toolId, interval.start);
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(nano(interval.end)); spanCount++; transcriptTools++;
    }
    step.end(nano(time.end));
  }
  const expectedTools = rounds.flatMap(round => round.tools).filter(tool => !localIds.has(tool.callId) && tool.completed).length;
  if (expectedTools > transcriptTools) owner.setAttribute(`${PREFIX}transcript_tools_not_in_span`, expectedTools - transcriptTools);
  return { spanCount, placements };
}

function fixedSpan(tracer: Tracer, name: string, attributes: Attributes, parent: SpanContext, id: string,
  start: bigint, kind = SpanKind.INTERNAL): Span {
  const span = tracer.startSpan(name, { kind, attributes, startTime: nano(start) }, trace.setSpanContext(ROOT_CONTEXT, parent));
  const generated = span.spanContext();
  Object.defineProperty(span, 'spanContext', { value: () => ({ ...generated, traceId: parent.traceId, spanId: id }), configurable: true });
  return span;
}

/** The request boundary, all completed local tools in a batch, and a native
 * Wait's explicit start/end are anchors. Parallel calls share one model round.
 * Missing intermediate timestamps are linearly placed between adjacent known
 * anchors; no model latency or provider request count is asserted as measured.
 */
function estimateRoundTimes(rounds: NativeAssistantRound[], records: EventLogRecord[], startNano: string, endNano: string,
  owner: EventLogRecord): RoundTimes[] | undefined {
  if (!isTime(startNano) || !isTime(endNano)) return undefined;
  const lower = BigInt(startNano), upper = BigInt(endNano);
  const boundaries: (bigint | undefined)[] = [lower];
  const indexes: { start: number; llmEnd: number; end: number; tools: Map<string, Interval> }[] = [];
  for (const round of rounds) {
    const tools = new Map<string, Interval>();
    for (const tool of round.tools) {
      const calls = records.filter(record => record['event.name'] === 'tool.call' && record['gen_ai.tool.call.id'] === tool.callId);
      const results = records.filter(record => record['event.name'] === 'tool.result' && record['gen_ai.tool.call.id'] === tool.callId);
      if (calls.length === 1 && results.length === 1) {
        const a = calls[0], b = results[0];
        if (isTime(a.time_unix_nano) && isTime(b.time_unix_nano) && a['gen_ai.tool.name'] === b['gen_ai.tool.name']
          && a['gen_ai.tool.name'] === tool.name
          && a['gen_ai.agent.id'] === owner['gen_ai.agent.id'] && b['gen_ai.agent.id'] === owner['gen_ai.agent.id']
          && ['trace_id', 'gen_ai.session.id', 'gen_ai.turn.id'].every(key => a[key] === b[key] && (owner[key] === undefined || a[key] === owner[key]))
          && BigInt(a.time_unix_nano) >= lower && BigInt(b.time_unix_nano) <= upper && BigInt(b.time_unix_nano) > BigInt(a.time_unix_nano)) {
          tools.set(tool.callId, { start: BigInt(a.time_unix_nano), end: BigInt(b.time_unix_nano), status: String(b['tool.result.status']) });
        }
      } else if (!calls.length && !results.length && tool.name === 'Wait' && tool.completed && typeof tool.result === 'string') {
        const interval = nativeWaitInterval(tool.result, lower, upper);
        if (interval) tools.set(tool.callId, interval);
      }
    }
    const known = [...tools.values()];
    const start = boundaries.length - 1;
    const llmEnd = boundaries.push(known.length ? known.reduce((a, b) => a < b.start ? a : b.start, known[0].start) : undefined) - 1;
    const end = round.callIds.length ? boundaries.push(known.length === round.callIds.length
      ? known.reduce((a, b) => a > b.end ? a : b.end, known[0].end) : undefined) - 1 : llmEnd;
    indexes.push({ start, llmEnd, end, tools });
  }
  if (boundaries.at(-1) === undefined) boundaries[boundaries.length - 1] = upper;
  let left = 0;
  for (let right = 1; right < boundaries.length; right++) {
    if (boundaries[right] === undefined) continue;
    const begin = boundaries[left]!, finish = boundaries[right]!;
    if (finish < begin || finish > upper) return undefined;
    for (let j = left + 1; j < right; j++) boundaries[j] = begin + (finish - begin) * BigInt(j - left) / BigInt(right - left);
    left = right;
  }
  const times = indexes.map(({ start, llmEnd, end, tools }) => ({ start: boundaries[start]!, llmEnd: boundaries[llmEnd]!, end: boundaries[end]!, tools }));
  if (times.some(time => [...time.tools.values()].some(tool => tool.start < time.llmEnd || tool.end > time.end))) return undefined;
  return times;
}

function nativeWaitInterval(result: string, lower: bigint, upper: bigint): Interval | undefined {
  try {
    const value = JSON.parse(result) as Record<string, unknown>;
    if (typeof value.started_at !== 'string' || typeof value.ended_at !== 'string'
      || typeof value.actual_waited_seconds !== 'number' || !Number.isFinite(value.actual_waited_seconds)) return undefined;
    const startMs = Date.parse(value.started_at), endMs = Date.parse(value.ended_at);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs
      || Math.abs((endMs - startMs) / 1000 - value.actual_waited_seconds) > 1) return undefined;
    const start = BigInt(startMs) * 1_000_000n, end = BigInt(endMs) * 1_000_000n;
    return start >= lower && end <= upper ? { start, end } : undefined;
  } catch { return undefined; }
}
