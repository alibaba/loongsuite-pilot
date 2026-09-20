// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import { __internal as legacy } from './transcript-parser.mjs';

const ns = value => Array.isArray(value) && value.length === 2
  ? String(BigInt(value[0]) * 1000000000n + BigInt(value[1])) : '';
const iso = value => value ? new Date(Number(BigInt(value) / 1000000n)).toISOString() : '';
const id = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Return complete, independently checkpointable interactions. No observation-time closure. */
export function parseInteractions(events, spans = [], { requireOtel = false } = {}) {
  const session = events.find(e => e.type === 'session.start');
  const sessionId = session?.data?.sessionId;
  if (!sessionId) return [];
  spans = spans.filter(s => s.type === 'span' && s.attributes?.['gen_ai.conversation.id'] === sessionId);
  const groups = new Map();
  let active;
  for (const e of events) {
    if (e.type === 'session.shutdown') continue;
    const explicit = e.data?.interactionId;
    if (explicit) active = explicit;
    // Old transcripts may lack interactionId. User event identity is the boundary,
    // never the round-trip turnId, which resets on every user interaction.
    if (!explicit && e.type === 'user.message') active = e.id;
    if (!active) continue;
    if (!groups.has(active)) groups.set(active, []);
    groups.get(active).push(e);
  }
  const batches = [];
  for (const [interaction, history] of groups) {
    const messages = history.filter(e => e.type === 'assistant.message');
    const chats = spans.filter(s => s.attributes?.['gen_ai.operation.name'] === 'chat'
      && s.attributes['github.copilot.interaction_id'] === interaction);
    const traceIds = new Set(chats.map(s => s.traceId));
    const root = spans.find(s => s.attributes?.['gen_ai.operation.name'] === 'invoke_agent'
      && traceIds.has(s.traceId) && !s.parentSpanId);
    const abort = history.find(e => e.type === 'abort');
    const finalMessage = messages.at(-1);
    const lastEnd = history.filter(e => e.type === 'assistant.turn_end').at(-1);
    const transcriptClosed = Boolean(abort || (finalMessage && !finalMessage.data?.toolRequests?.length
      && lastEnd && lastEnd.timestamp >= finalMessage.timestamp));
    if (requireOtel && !root) continue;
    if (!root && !transcriptClosed) continue;
    // Root may reach disk before transcript messages. Wait rather than checkpoint
    // a half-correlated interaction. Failed calls legitimately have no message.
    if (requireOtel && chats.some(c => c.status?.code !== 2 && !messages.some(m => m.data?.apiCallId === c.attributes['gen_ai.response.id']))) continue;
    if (requireOtel && messages.some(m => !chats.some(c => c.attributes['gen_ai.response.id'] === m.data?.apiCallId))) continue;
    const trace = id(`copilot:${sessionId}:${interaction}`);
    const turn = `copilot:${sessionId}:${interaction}`;
    const entries = [];
    const scoped = records => records.map(r => {
      const result = { ...r, trace_id: trace, 'gen_ai.turn.id': turn,
        'gen_ai.copilot.interaction.id': interaction, 'gen_ai.copilot.source': 'hybrid-v2' };
      delete result['gen_ai.turn.start']; delete result['gen_ai.turn.end'];
      return result;
    });
    const starts = new Map(history.filter(e => e.type === 'assistant.turn_start').map(e => [e.data?.turnId, e]));
    const apiMessages = new Map();
    for (const m of messages) {
      const key = m.data?.apiCallId || m.data?.messageId || m.id;
      if (!apiMessages.has(key)) apiMessages.set(key, []);
      apiMessages.get(key).push(m);
    }
    // Failed provider calls can exist only in OTel. Preserve them without inventing output.
    for (const c of chats) if (!apiMessages.has(c.attributes['gen_ai.response.id']) && c.status?.code === 2)
      apiMessages.set(c.attributes['gen_ai.response.id'] || c.spanId, []);
    for (const [apiId, ms] of apiMessages) {
      const c = chats.find(s => s.attributes['gen_ai.response.id'] === apiId || s.spanId === apiId);
      const a = c?.attributes || {};
      const step = String(a['github.copilot.turn_id'] ?? ms[0]?.data?.turnId ?? apiId);
      const start = starts.get(step);
      const model = a['gen_ai.response.model'] || ms[0]?.data?.model || a['gen_ai.request.model'] || '';
      const startNs = ns(c?.startTime) || legacy.isoToUnixNanos(start?.timestamp || ms[0]?.timestamp);
      const endNs = ns(c?.endTime) || legacy.isoToUnixNanos(ms.at(-1)?.timestamp);
      if (!startNs || !endNs) continue;
      const input = [];
      for (const e of events) {
        const when = legacy.isoToUnixNanos(e.timestamp);
        if (!when || BigInt(when) >= BigInt(startNs)) continue;
        if (e.type === 'system.message' || e.type === 'user.message') {
          if (typeof e.data?.content === 'string') input.push({role:e.type === 'system.message' ? 'system' : 'user',parts:[{type:'text',content:e.data.content}]});
        } else if (e.type === 'assistant.message') {
          input.push({role:'assistant',parts:legacy.buildAssistantOutputParts(e.data).parts});
        } else if (e.type === 'tool.execution_complete' && e.data?.toolCallId) {
          input.push({role:'tool',parts:[{type:'tool_call_response',id:e.data.toolCallId,response:e.data.result ?? null}]});
        }
      }
      const llm = ms.length ? legacy.buildMergedLlmSpan(sessionId, trace, step, ms, start, null, model, input, null, null) : {
        'event.name': 'llm.response', 'user.id': '', 'gen_ai.session.id': sessionId,
        'gen_ai.agent.type': 'copilot', 'gen_ai.step.id': step,
        'gen_ai.request.model': model, 'gen_ai.response.model': model,
      };
      llm['event.id'] = id(`${turn}:llm:${apiId}`);
      llm['gen_ai.response.id'] = apiId;
      llm['gen_ai.request.id'] = apiId;
      llm['gen_ai.provider.name'] = a['gen_ai.provider.name'] || legacy.inferProviderName(model);
      llm.time_unix_nano = startNs; llm._merged_end_time_unix_nano = endNs;
      if (c) {
        for (const key of ['input_tokens', 'output_tokens', 'cache_read.input_tokens', 'cache_creation.input_tokens', 'reasoning.output_tokens']) {
          const value = a[`gen_ai.usage.${key}`];
          if (number(value)) llm[`gen_ai.usage.${key}`] = value;
        }
        if (number(llm['gen_ai.usage.input_tokens']) && number(llm['gen_ai.usage.output_tokens']))
          llm['gen_ai.usage.total_tokens'] = llm['gen_ai.usage.input_tokens'] + llm['gen_ai.usage.output_tokens'];
        if (Array.isArray(a['gen_ai.response.finish_reasons'])) llm['gen_ai.response.finish_reasons'] = a['gen_ai.response.finish_reasons'];
        if (c.status?.code === 2) llm['error.type'] = a['error.type'] || 'provider_error';
      }
      const request = {
        'event.name': 'llm.request', 'event.id': id(`${turn}:request:${apiId}`),
        'user.id': '', 'gen_ai.session.id': sessionId, 'gen_ai.agent.type': 'copilot',
        'gen_ai.step.id': step, 'gen_ai.request.id': apiId, 'gen_ai.response.id': apiId,
        'gen_ai.request.model': a['gen_ai.request.model'] || model,
        'gen_ai.provider.name': llm['gen_ai.provider.name'], time_unix_nano: startNs,
        ...(llm['gen_ai.input.messages'] ? { 'gen_ai.input.messages': llm['gen_ai.input.messages'] } : {}),
      };
      llm.time_unix_nano = endNs;
      entries.push(request, llm);
    }
    for (const start of history.filter(e => e.type === 'tool.execution_start')) {
      const callId = start.data?.toolCallId;
      const complete = history.find(e => e.type === 'tool.execution_complete' && e.data?.toolCallId === callId);
      const tool = spans.find(s => s.attributes?.['gen_ai.operation.name'] === 'execute_tool'
        && s.attributes['gen_ai.tool.call.id'] === callId && traceIds.has(s.traceId));
      if (!complete && !tool) continue; // no synthetic success for an unfinished tool
      const step = start.data?.turnId;
      const model = messages.find(e => e.data?.turnId === step)?.data?.model || '';
      const call = legacy.buildToolCallSpan(sessionId, trace, step, start, complete, model);
      const result = legacy.buildToolResultSpan(sessionId, trace, step, start, complete,
        history.find(e => e.type === 'permission.completed' && e.data?.toolCallId === callId), model);
      if (tool) {
        call.time_unix_nano = ns(tool.startTime); result.time_unix_nano = ns(tool.endTime);
        if (tool.status?.code === 2) { result['gen_ai.tool.success'] = false; result['error.type'] = tool.attributes['error.type'] || 'tool_error'; }
      }
      if (result['gen_ai.tool.success'] === false) result['error.type'] ||= result['error.code'] || 'tool_error';
      entries.push(call, result);
    }
    // One step endpoint per round-trip keeps all child end timestamps visible to
    // the converter; it must not act as an independent interaction boundary.
    for (const step of new Set(entries.map(e => e['gen_ai.step.id']))) {
      const children = entries.filter(e => e['gen_ai.step.id'] === step);
      const end = children.map(e => e._merged_end_time_unix_nano || e.time_unix_nano).reduce((a,b) => BigInt(a)>BigInt(b)?a:b);
      const first = children.reduce((a,b) => BigInt(a.time_unix_nano)<BigInt(b.time_unix_nano)?a:b);
      entries.push(legacy.buildStepSpan(sessionId,trace,step,{id:id(`${turn}:step:${step}`),timestamp:iso(first.time_unix_nano)},null,first['gen_ai.request.model']||'',end));
    }
    const records = scoped(entries);
    if (!records.length) continue;
    records.at(-1)['gen_ai.turn.end'] = true;
    if (root?.status?.code === 2 || abort) records.at(-1)['gen_ai.copilot.interaction.error'] = root?.attributes?.['error.type'] || 'cancelled';
    batches.push({ key: turn, records });
  }
  // A session summary is a log event, not another interaction/LLM. Preserve all
  // models and emit it independently even if every interaction was already sent.
  for (const shutdown of events.filter(e => e.type === 'session.shutdown')) {
    const key = `copilot:${sessionId}:summary:${shutdown.id}`;
    batches.push({ key, records: [{
      'event.name': 'other', 'event.id': id(key), 'user.id': '',
      'gen_ai.agent.type': 'copilot', 'gen_ai.provider.name': '', 'gen_ai.session.id': sessionId,
      'gen_ai.copilot.session_summary': true,
      'gen_ai.session.model_metrics': shutdown.data?.modelMetrics || {},
      'gen_ai.session.total_api_duration_ms': shutdown.data?.totalApiDurationMs,
      time_unix_nano: legacy.isoToUnixNanos(shutdown.timestamp),
    }] });
  }
  return batches;
}
