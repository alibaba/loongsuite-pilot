import assert from 'node:assert/strict';

export function assertOpenClawSessionKey({ rawEvents, events, spans, sessionKey }) {
  const key = 'agent.openclaw.session_key';
  assert(typeof sessionKey === 'string' && sessionKey.length > 0, 'native session key required');
  for (const [name, rows] of Object.entries({ rawEvents, events, spans })) {
    assert(rows.length > 0, `empty ${name}`);
    for (const row of rows) {
      assert.equal((row.attributes ?? row)[key], sessionKey, `${name}: session key mismatch`);
      assert.equal(row.resource?.[key], undefined, 'session key must not be a Resource');
    }
  }
  return { sessionKey, rawEvents: rawEvents.length, events: events.length, spans: spans.length };
}

// Self-contained acceptance rules for this Gateway scenario, not a replacement
// for every ARMS semantic convention. No untracked rules file is required.
export function assertOpenClawEvidence({ events, spans, nativeMessages, provider, model, service, workerName, turns, expectedToolErrorTraceIds = [] }) {
  assert(events.length > 0 && spans.length > 0, 'empty evidence');
  assert.equal(new Set(events.map(e => e['event.id'])).size, events.length, 'duplicate event IDs');
  assert.equal(new Set(spans.map(s => `${s.traceId}/${s.spanId}`)).size, spans.length, 'duplicate spans');
  assert(!events.some(e => ['session_start', 'session_end'].includes(e['agent.openclaw.hook'])), 'session-only events escaped input');
  const responses = events.filter(e => e['event.name'] === 'llm.response');
  const requests = events.filter(e => e['event.name'] === 'llm.request');
  assert(responses.length > 0, 'no model responses');
  assert.equal(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM').length, responses.length, 'LLM span count');
  const native = nativeMessages.filter(m => m.role === 'assistant');
  assert.equal(responses.length, native.length, 'native response count');
  assert.equal(requests.length, responses.length, 'request/response count');
  assert.equal(new Set(responses.map(e => e['gen_ai.session.id'])).size, 1, 'Gateway session continuity');
  const tokenChecks = responses.map((e, i) => {
    const usage = native[i].usage;
    assert(usage, 'native usage missing');
    const input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const output = usage.output;
    assert(input > 0 && output > 0, 'native usage not positive');
    for (const [key, value] of Object.entries({ input_tokens: input, output_tokens: output,
      total_tokens: input + output, 'cache_read.input_tokens': usage.cacheRead ?? 0,
      'cache_creation.input_tokens': usage.cacheWrite ?? 0 })) {
      assert.equal(e[`gen_ai.usage.${key}`] ?? 0, value, `native token mismatch: ${key}`);
    }
    const llm = spans.find(s => s.traceId === e.trace_id && s.attributes['gen_ai.span.kind'] === 'LLM'
      && s.attributes['gen_ai.response.id'] === e['gen_ai.response.id']);
    assert(llm, 'normalized response missing from trace');
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read.input_tokens', 'cache_creation.input_tokens']) {
      assert.equal(llm.attributes[`gen_ai.usage.${key}`] ?? 0, e[`gen_ai.usage.${key}`] ?? 0, `span token mismatch: ${key}`);
    }
    assert.equal(llm.attributes['gen_ai.provider.name'], provider);
    assert.equal(llm.attributes['gen_ai.request.model'], model);
    return { traceId: e.trace_id, turnId: e['gen_ai.turn.id'], input, output, cacheRead: usage.cacheRead ?? 0 };
  });
  const calls = events.filter(e => e['event.name'] === 'tool.call');
  const results = events.filter(e => e['event.name'] === 'tool.result');
  const toolKey = e => `${e.trace_id}/${e['gen_ai.tool.call.id']}`;
  assert(calls.length >= 2, 'real tool calls missing');
  assert.deepEqual(calls.map(toolKey).sort(), results.map(toolKey).sort(), 'tool pairing');
  assert.equal(new Set(calls.map(toolKey)).size, calls.length, 'duplicate tool call IDs');
  assert.deepEqual(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL')
    .map(s => `${s.traceId}/${s.attributes['gen_ai.tool.call.id']}`).sort(), calls.map(toolKey).sort(), 'TOOL span pairing');
  const traceIds = [...new Set(spans.map(s => s.traceId))];
  assert.equal(traceIds.length, turns, 'expected one trace per turn, no lifecycle-only traces');
  assert.equal(new Set(responses.map(e => e['gen_ai.turn.id'])).size, turns, 'turn separation');
  for (const traceId of traceIds) {
    const tree = spans.filter(s => s.traceId === traceId);
    const kind = s => s.attributes['gen_ai.span.kind'];
    for (const rootKind of ['ENTRY', 'AGENT']) assert.equal(tree.filter(s => kind(s) === rootKind).length, 1, rootKind);
    for (const span of tree) {
      assert.equal(span.resource['service.name'], service, 'service name');
      assert.equal(span.resource['agentteams.worker.name'], workerName, 'worker resource');
      if (span.status?.code === 2) {
        assert(kind(span) === 'TOOL' && expectedToolErrorTraceIds.includes(traceId)
          && span.attributes['gen_ai.tool.name'] === 'read' && span.attributes['error.type'], 'unexpected error span');
      }
      const start = BigInt(span.startTimeUnixNano), end = BigInt(span.endTimeUnixNano);
      assert(end > start, 'nonpositive duration');
      if (kind(span) === 'ENTRY') continue;
      const parent = tree.find(s => s.spanId === span.parentSpanId);
      assert(parent, 'missing parent');
      assert.equal(kind(parent), { AGENT: 'ENTRY', STEP: 'AGENT', LLM: 'STEP', TOOL: 'STEP' }[kind(span)], 'topology');
      assert(BigInt(parent.startTimeUnixNano) <= start && end <= BigInt(parent.endTimeUnixNano), 'time containment');
    }
    const llms = tree.filter(s => kind(s) === 'LLM');
    const agent = tree.find(s => kind(s) === 'AGENT');
    assert.equal(agent.attributes['gen_ai.agent.name'], workerName, 'worker agent name');
    for (const suffix of ['input_tokens', 'output_tokens', 'total_tokens']) {
      assert.equal(agent.attributes[`gen_ai.usage.${suffix}`], llms.reduce((sum, s) => sum + s.attributes[`gen_ai.usage.${suffix}`], 0), `aggregate ${suffix}`);
    }
  }
  return { traceIds, tokenChecks, events: events.length, spans: spans.length, tools: calls.length };
}

export function assertContentOff(records, markers) {
  assert(records.length > 0, 'privacy test has no records');
  const forbidden = ['gen_ai.input.messages', 'gen_ai.input.messages_delta', 'gen_ai.output.messages',
    'gen_ai.system_instructions', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'error.message'];
  for (const record of records) {
    const attrs = record.attributes ?? record;
    for (const key of forbidden) assert.equal(attrs[key], undefined, `content-off leaked ${key}`);
    assert(markers.every(marker => !JSON.stringify(record).includes(marker)), 'privacy marker leaked');
  }
}
