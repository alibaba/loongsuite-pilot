import { createHash } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';

const historyKey = 'loongsuite.trae_cn.model_responses';

// The Hook converter's single STEP and LLM represent an entire user turn.
// Replace that pair only when the terminal response is bound to native history.
export function expandTraeHistory(records: AgentActivityEntry[], spans: ReadableSpan[]): ReadableSpan[] {
  const summary = records.find(r => r['event.name'] === 'llm.response' && Array.isArray(r[historyKey]));
  const rounds = summary?.[historyKey];
  if (!Array.isArray(rounds) || !rounds.length) return spans;
  const byId = new Map(spans.map(s => [s.spanContext().spanId, s]));
  const llm = summary?.span_id && byId.get(summary.span_id);
  const step = llm && llm.parentSpanId && byId.get(llm.parentSpanId);
  const agent = step && step.parentSpanId && byId.get(step.parentSpanId);
  if (!llm || !step || !agent || llm.attributes['gen_ai.span.kind'] !== 'LLM' ||
      step.attributes['gen_ai.span.kind'] !== 'STEP' || agent.attributes['gen_ai.span.kind'] !== 'AGENT') return spans;
  const trace = llm.spanContext().traceId;
  const observed: ReadableSpan[] = [];
  const parents = new Map<string, { id: string; history: string }>();
  // Use the converted (content-policy filtered) messages. A continuation's
  // observable input is the committed tool result, not the entire model prompt.
  const resultByCall = new Map(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL')
    .map(s => [s.attributes['gen_ai.tool.call.id'], s.attributes['gen_ai.tool.call.result']]));
  const callsByRequest = new Map<string, string[]>();
  for (const round of rounds) {
    if (round && typeof round === 'object' && !Array.isArray(round) && typeof round.request === 'string' && Array.isArray(round.toolIds))
      callsByRequest.set(round.request, round.toolIds.filter((id): id is string => typeof id === 'string'));
  }
  let assistantParts: { type: string; id?: string }[] = [];
  const output = llm.attributes['gen_ai.output.messages'];
  if (typeof output === 'string') {
    try {
      const messages = JSON.parse(output);
      if (Array.isArray(messages)) assistantParts = messages.flatMap(m =>
        m?.role === 'assistant' && Array.isArray(m.parts) ? m.parts.filter((p: { type?: string }) => p?.type) : []);
    } catch { /* The converter can omit or truncate optional content. */ }
  }
  const seen = new Set<string>();
  for (const r of rounds) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !/^[a-f0-9]{24}$/.test(r.id) ||
        typeof r.at !== 'string' || !/^\d{1,19}$/.test(r.at) || seen.has(r.id)) return spans;
    seen.add(r.id);
    const ns = BigInt(r.at);
    const instant: [number, number] = [Number(ns / 1000000000n), Number(ns % 1000000000n)];
    let parent = agent.spanContext().spanId;
    const templates: ReadableSpan[] = [step, llm];
    for (const template of templates) {
      const isModel = template === llm;
      const id = createHash('sha256').update([trace, r.id, isModel ? 'llm' : 'step'].join('/')).digest('hex').slice(0, 16);
      const attributes: ReadableSpan['attributes'] = {};
      for (const key of ['gen_ai.span.kind', 'gen_ai.operation.name', 'gen_ai.agent.name', 'gen_ai.agent.id',
        'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.user.id', 'gen_ai.request.model', 'workspace.path']) {
        if (template.attributes[key] !== undefined) attributes[key] = template.attributes[key];
      }
      attributes['gen_ai.step.id'] = r.id;
      attributes['loongsuite.trae_cn.observation'] = 'response_recorded';
      if (typeof r.request === 'string') attributes['loongsuite.trae_cn.stream_request_id'] = r.request;
      if (isModel) {
        attributes['gen_ai.response.id'] = r.id;
        const prompt = llm.attributes['gen_ai.input.messages'];
        if (r.initial === true && typeof prompt === 'string') attributes['gen_ai.input.messages'] = prompt;
        if (typeof r.continuation === 'string') {
          const parts = (callsByRequest.get(r.continuation) ?? []).flatMap(id => {
            const response = resultByCall.get(id);
            return response === undefined ? [] : [{ type: 'tool_call_response', id, response }];
          });
          if (parts.length) attributes['gen_ai.input.messages'] = JSON.stringify([{ role: 'tool', parts }]);
        }
        const calls = Array.isArray(r.toolIds) ? r.toolIds : [];
        const parts = assistantParts.filter(p => (p.type === 'tool_call' && p.id && calls.includes(p.id))
          || (r.terminal === true && p.type === 'text'));
        if (parts.length) attributes['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', parts }]);
        if (typeof r.input === 'number' && typeof r.output === 'number') {
          attributes['gen_ai.usage.input_tokens'] = r.input;
          attributes['gen_ai.usage.output_tokens'] = r.output;
          attributes['gen_ai.usage.total_tokens'] = r.input + r.output;
          if (typeof r.cached === 'number') attributes['gen_ai.usage.cache_read.input_tokens'] = r.cached;
        }
      } else {
        attributes['gen_ai.react.round'] = seen.size;
        if (Array.isArray(r.toolIds)) for (const call of r.toolIds) {
          if (typeof call === 'string') parents.set(call, { id, history: r.id });
        }
      }
      observed.push({ ...template, name: template.name, kind: template.kind, resource: template.resource,
        instrumentationLibrary: template.instrumentationLibrary, ended: true, droppedEventsCount: 0,
        droppedLinksCount: 0, droppedAttributesCount: 0, links: [], events: [], status: { code: 0 },
        spanContext: () => ({ ...template.spanContext(), spanId: id }), parentSpanId: parent,
        startTime: instant, endTime: instant, duration: [0, 0], attributes });
      parent = id;
    }
  }
  let unassigned = false;
  for (const span of spans) {
    if (span === llm || span.parentSpanId !== step.spanContext().spanId) continue;
    const parent = parents.get(String(span.attributes['gen_ai.tool.call.id']));
    if (parent) {
      Object.assign(span, { parentSpanId: parent.id });
      span.attributes['gen_ai.step.id'] = parent.history;
    } else unassigned = true;
  }
  if (unassigned) {
    Object.assign(step, { name: 'tool execution (round unknown)' });
    delete step.attributes['gen_ai.react.round'];
    step.attributes['loongsuite.trae_cn.observation'] = 'unattributed_tools';
  }
  for (const [key, value] of Object.entries(llm.attributes)) {
    if (key.startsWith('gen_ai.usage.') || key.startsWith('agent.trae-cn.hub.')) agent.attributes[key] = value;
  }
  return [...spans.filter(s => (s !== step || unassigned) && s !== llm), ...observed];
}
