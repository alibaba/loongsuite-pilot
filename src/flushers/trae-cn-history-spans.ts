import { createHash } from 'node:crypto';
import { hrTimeDuration } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';

const historyKey = 'loongsuite.trae_cn.model_responses';

function earlier(a: ReadableSpan['startTime'], b: ReadableSpan['startTime']): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function hrTime(ns: bigint): ReadableSpan['startTime'] {
  return [Number(ns / 1000000000n), Number(ns % 1000000000n)];
}

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
  const agentStart = BigInt(agent.startTime[0]) * 1000000000n + BigInt(agent.startTime[1]);
  const nativeToolBounds = new Map<string, { start?: bigint; end?: bigint }>();
  for (const record of records) {
    const timestamp = record.time_unix_nano;
    if (record['agent.trae-cn.tool_timing_source'] !== 'native_start_to_batch_commit' ||
        !record.span_id || typeof timestamp !== 'string' || !/^\d{1,19}$/.test(timestamp)) continue;
    const range = nativeToolBounds.get(record.span_id) ?? {};
    if (record['event.name'] === 'tool.call') range.start = BigInt(timestamp);
    if (record['event.name'] === 'tool.result') range.end = BigInt(timestamp);
    nativeToolBounds.set(record.span_id, range);
  }
  if (nativeToolBounds.size > 0) {
    spans = spans.map(span => {
      const range = nativeToolBounds.get(span.spanContext().spanId);
      if (span.attributes['gen_ai.span.kind'] !== 'TOOL' ||
          range?.start === undefined || range.end === undefined || range.start > range.end) return span;
      // The generic converter rounds tool times to milliseconds. Copy the
      // ended span to preserve exact native times without changing SDK state.
      const startTime = hrTime(range.start);
      const endTime = hrTime(range.end);
      return { ...span, spanContext: () => span.spanContext(), ended: span.ended,
        droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount, startTime, endTime, duration: hrTimeDuration(startTime, endTime),
        attributes: { ...span.attributes, 'loongsuite.trae_cn.observation': 'native_tool_acknowledged' } };
    });
  }
  const observed: ReadableSpan[] = [];
  const parents = new Map<string, { span: ReadableSpan; history: string }>();
  // Use the converted (content-policy filtered) messages. A continuation's
  // observable input is the committed tool result, not the entire model prompt.
  const resultByCall = new Map(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL')
    .map(s => [s.attributes['gen_ai.tool.call.id'], s.attributes['gen_ai.tool.call.result']]));
  const callsByRequest = new Map<string, string[]>();
  for (const round of rounds) {
    if (round && typeof round === 'object' && !Array.isArray(round) && typeof round.request === 'string' && Array.isArray(round.toolIds))
      callsByRequest.set(round.request, round.toolIds.filter((id): id is string => typeof id === 'string'));
  }
  let assistantParts: { type: string; id?: string; tool_call_id?: string; content?: unknown }[] = [];
  const output = llm.attributes['gen_ai.output.messages'];
  if (typeof output === 'string') {
    try {
      const messages = JSON.parse(output);
      if (Array.isArray(messages)) assistantParts = messages.flatMap(m =>
        m?.role === 'assistant' && Array.isArray(m.parts) ? m.parts.filter((p: { type?: string }) => p?.type) : []);
    } catch { /* The converter can omit or truncate optional content. */ }
  }
  const sharedSteps = new Map<string, ReadableSpan>();
  const seen = new Set<string>();
  let sharedTerminal = false;
  for (const r of rounds) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !/^[a-f0-9]{24}$/.test(r.id) ||
        typeof r.at !== 'string' || !/^\d{1,19}$/.test(r.at) || seen.has(r.id)) return spans;
    seen.add(r.id);
    const ns = BigInt(r.at);
    const instant = hrTime(ns);
    let parent = agent.spanContext().spanId;
    const shared = r.shared === true && typeof r.request === 'string' ? r.request : undefined;
    if (shared && r.terminal === true) sharedTerminal = true;
    const headers = typeof r.headersAt === 'string' && /^\d{1,19}$/.test(r.headersAt) ? BigInt(r.headersAt) : undefined;
    const layers = shared ? ['stream', 'round', 'model'] : ['round', 'model'];
    for (const layer of layers) {
      const isModel = layer === 'model';
      const isStream = layer === 'stream';
      const template = isModel ? llm : step;
      const existing = shared && isStream ? sharedSteps.get(shared) : undefined;
      if (existing) {
        const startTime = earlier(instant, existing.startTime) ? instant : existing.startTime;
        const endTime = earlier(existing.endTime, instant) ? instant : existing.endTime;
        Object.assign(existing, { startTime, endTime, duration: hrTimeDuration(startTime, endTime) });
        continue;
      }
      const id = createHash('sha256').update([trace, isStream ? 'stream/' + shared : r.id, isModel ? 'llm' : 'step'].join('/')).digest('hex').slice(0, 16);
      const attributes: ReadableSpan['attributes'] = {};
      for (const key of ['gen_ai.span.kind', 'gen_ai.operation.name', 'gen_ai.agent.name', 'gen_ai.agent.id',
        'gen_ai.session.id', 'gen_ai.conversation.id', 'gen_ai.provider.name', 'gen_ai.turn.id', 'gen_ai.user.id', 'gen_ai.request.model', 'workspace.path',
        'workspace.current_root', 'git.repo', 'git.branch', 'git.domain']) {
        if (template.attributes[key] !== undefined) attributes[key] = template.attributes[key];
      }
      attributes['gen_ai.step.id'] = isStream ? shared! : r.id;
      attributes['loongsuite.trae_cn.observation'] = 'response_recorded';
      if (typeof r.request === 'string') attributes['loongsuite.trae_cn.stream_request_id'] = r.request;
      if (isModel) attributes['gen_ai.response.id'] = r.id;
      // Shared streams prove the batch of messages, but not which response owns each one.
      if (isStream || (!shared && isModel)) {
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
          || (p.type === 'reasoning' && p.tool_call_id && calls.includes(p.tool_call_id))
          || (r.terminal === true && p.type === 'text'));
        if (parts.length) attributes['gen_ai.output.messages'] = JSON.stringify([{ role: 'assistant', parts }]);
        if (shared && typeof r.streamReceived === 'number') {
          attributes['agent.trae-cn.hub.usage_received'] = r.streamReceived;
          if (typeof r.streamExpected === 'number') attributes['agent.trae-cn.hub.usage_expected'] = r.streamExpected;
          if (typeof r.streamTokens === 'number') attributes['agent.trae-cn.hub.total_tokens_observed'] = r.streamTokens;
        }
        if (typeof r.input === 'number' && typeof r.output === 'number') {
          attributes['gen_ai.usage.input_tokens'] = r.input;
          attributes['gen_ai.usage.output_tokens'] = r.output;
          attributes['gen_ai.usage.total_tokens'] = r.input + r.output;
          if (typeof r.reasoning === 'number') attributes['gen_ai.usage.reasoning_tokens'] = r.reasoning;
          if (typeof r.cacheCreated === 'number') attributes['gen_ai.usage.cache_creation.input_tokens'] = r.cacheCreated;
          if (typeof r.cached === 'number') attributes['gen_ai.usage.cache_read.input_tokens'] = r.cached;
        }
      }
      if (layer === 'round') {
        attributes['gen_ai.react.round'] = seen.size;
      }
      let startTime = instant;
      // A uniquely owned stream gives us a client-side interval. The server
      // can dispatch tools before the client records the model history.
      if (!shared && typeof r.request === 'string' && headers !== undefined && headers >= agentStart && headers < ns) {
        startTime = hrTime(headers);
        attributes['loongsuite.trae_cn.timing_source'] = 'response_headers_to_history_recorded';
      }
      if (r.initial === true && typeof r.requestStartMs === 'number' && typeof r.firstTokenMs === 'number' &&
          Number.isSafeInteger(r.requestStartMs) && Number.isSafeInteger(r.firstTokenMs) &&
          r.requestStartMs > 0 && r.firstTokenMs >= r.requestStartMs && BigInt(r.firstTokenMs) * 1000000n <= ns &&
          (isStream || !shared)) {
        // The history timestamp records persistence, not the end of inference.
        // Include the measured request start in the STEP if it extends the interval.
        const requestStart: [number, number] = [Math.floor(r.requestStartMs / 1000), (r.requestStartMs % 1000) * 1000000];
        if (!isModel && earlier(requestStart, startTime)) startTime = requestStart;
        attributes['loongsuite.trae_cn.request_to_first_token_ns'] = (r.firstTokenMs - r.requestStartMs) * 1000000;
        const elapsed = BigInt(r.firstTokenMs) * 1000000n - agentStart;
        if (elapsed >= 0n && elapsed <= BigInt(Number.MAX_SAFE_INTEGER)) agent.attributes['gen_ai.response.time_to_first_token'] = Number(elapsed);
      }
      const observation: ReadableSpan = { ...template, name: template.name, kind: template.kind, resource: template.resource,
        instrumentationLibrary: template.instrumentationLibrary, ended: true, droppedEventsCount: 0,
        droppedLinksCount: 0, droppedAttributesCount: 0, links: [], events: [], status: { code: 0 },
        spanContext: () => ({ ...template.spanContext(), spanId: id }), parentSpanId: parent,
        startTime, endTime: instant, duration: hrTimeDuration(startTime, instant), attributes };
      if (shared && isStream) {
        Object.assign(observation, { name: 'response stream (multiple model responses)' });
        sharedSteps.set(shared, observation);
      }
      observed.push(observation);
      if ((isStream || (!shared && layer === 'round')) && Array.isArray(r.toolIds)) for (const call of r.toolIds) {
        if (typeof call === 'string') parents.set(call, { span: observation, history: shared || r.id });
      }
      // Stream-scoped evidence and per-history rounds are sibling STEPs.
      if (!isStream) parent = id;
    }
  }
  let unassigned = false;
  for (const span of spans) {
    if (span === llm || span.parentSpanId !== step.spanContext().spanId) continue;
    const parent = parents.get(String(span.attributes['gen_ai.tool.call.id']));
    if (parent) {
      const owner = parent.span;
      Object.assign(span, { parentSpanId: owner.spanContext().spanId });
      span.attributes['gen_ai.step.id'] = parent.history;
      const stream = owner.attributes['loongsuite.trae_cn.stream_request_id'];
      if (typeof stream === 'string') {
        span.attributes['loongsuite.trae_cn.stream_request_id'] = stream;
        if (sharedSteps.get(stream) !== owner) span.attributes['loongsuite.trae_cn.history_id'] = parent.history;
      }
      // A response timestamp describes the model observation. The STEP also
      // encompasses the measured execution of any tools it dispatched.
      const startTime = earlier(span.startTime, owner.startTime) ? span.startTime : owner.startTime;
      const endTime = earlier(owner.endTime, span.endTime) ? span.endTime : owner.endTime;
      Object.assign(owner, { startTime, endTime, duration: hrTimeDuration(startTime, endTime) });
    } else unassigned = true;
  }
  if (unassigned) {
    Object.assign(step, { name: 'tool execution (round unknown)' });
    delete step.attributes['gen_ai.react.round'];
    step.attributes['loongsuite.trae_cn.observation'] = 'unattributed_tools';
  }
  // Move aggregate usage to the AGENT so consumers can sum measured model
  // responses independently.
  for (const [key, value] of Object.entries(llm.attributes)) {
    if (!key.startsWith('gen_ai.usage.') && !key.startsWith('agent.trae-cn.hub.')) continue;
    agent.attributes[key] = value;
    delete llm.attributes[key];
  }
  // Count the numeric receipts once at agent scope, including receipts for
  // model spans omitted for missing content. Coverage stays on the same span.
  if (agent.attributes['agent.trae-cn.hub.complete'] === false &&
      agent.attributes['gen_ai.usage.input_tokens'] === undefined &&
      agent.attributes['gen_ai.usage.output_tokens'] === undefined &&
      agent.attributes['gen_ai.usage.total_tokens'] === undefined) {
    for (const [observed, metric] of [['input_tokens_observed', 'input_tokens'], ['output_tokens_observed', 'output_tokens'],
      ['total_tokens_observed', 'total_tokens'], ['cached_tokens_observed', 'cache_read.input_tokens']]) {
      const value = agent.attributes['agent.trae-cn.hub.' + observed];
      if (typeof value === 'number') agent.attributes['gen_ai.usage.' + metric] = value;
    }
  }
  // A turn summary is not an additional inference. Keep its messages at
  // agent scope even when a per-history message cannot be reconstructed.
  for (const key of ['gen_ai.input.messages', 'gen_ai.output.messages']) {
    if (llm.attributes[key] !== undefined) agent.attributes[key] ??= llm.attributes[key];
  }
  if (sharedTerminal) {
    agent.attributes['loongsuite.trae_cn.observation'] = 'turn_summary';
  }
  return [...spans.filter(s => (s !== step || unassigned) && s !== llm), ...observed];
}

function hasMessageBody(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const messages = JSON.parse(value);
    return Array.isArray(messages) && messages.some(message =>
      Array.isArray(message?.parts) && message.parts.some((part: Record<string, unknown> | null) => {
        if (!part) return false;
        if (part.type === 'tool_call') return typeof part.name === 'string' && !!part.name.trim();
        if (part.type === 'tool_call_response') {
          return typeof part.response === 'string' ? !!part.response.trim() : part.response != null;
        }
        return typeof part.content === 'string' && !!part.content.trim();
      }));
  } catch {
    return false;
  }
}

function hasModelMessages(span: ReadableSpan): boolean {
  return hasMessageBody(span.attributes['gen_ai.input.messages']) &&
    hasMessageBody(span.attributes['gen_ai.output.messages']);
}

// The TRAE tree uses STEP parents for both LLM and TOOL. Keep a tool's
// STEP even when the corresponding model messages could not be recovered.
export function omitEmptyTraeModelSpans(spans: ReadableSpan[]): ReadableSpan[] {
  const empty = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM' &&
    !hasModelMessages(s));
  const removed = new Map(empty.map(s => [s.spanContext().spanId, s.parentSpanId]));
  const kept = spans.filter(s => !removed.has(s.spanContext().spanId));
  for (const span of kept) {
    if (span.parentSpanId && removed.has(span.parentSpanId)) {
      Object.assign(span, { parentSpanId: removed.get(span.parentSpanId) });
    }
  }
  const withChildren = new Set(kept.map(s => s.parentSpanId));
  return kept.filter(s => s.attributes['gen_ai.span.kind'] !== 'STEP' ||
    withChildren.has(s.spanContext().spanId));
}
