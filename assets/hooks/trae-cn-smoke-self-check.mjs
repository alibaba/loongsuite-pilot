#!/usr/bin/env node
// Local smoke self-check for trae-cn hook processor output.
// Mirrors the structural rules validate-trace enforces at the OTLP layer:
// single ENTRY/AGENT/STEP, parent chain ENTRY→AGENT→STEP→LLM/TOOL, single
// trace_id per turn, non-empty messages on llm.request/llm.response, tool
// call/result joined by gen_ai.tool.call.id.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { input: { type: 'string', short: 'i' } },
  strict: true,
});
if (!values.input) {
  console.error('usage: node trae-cn-smoke-self-check.mjs -i <jsonl>');
  process.exit(2);
}
const TAG = '[trae-cn-smoke]';
const spans = [];
for (const line of readFileSync(values.input, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  spans.push(JSON.parse(line));
}
const errors = [];
const warns = [];

if (spans.length === 0) {
  errors.push('no spans in input');
} else {
  const kinds = spans.map((s) => s['gen_ai.span.kind']);
  const count = (k) => kinds.filter((x) => x === k).length;
  if (count('ENTRY') !== 1) errors.push(`expected 1 ENTRY, got ${count('ENTRY')}`);
  if (count('AGENT') !== 1) errors.push(`expected 1 AGENT, got ${count('AGENT')}`);
  if (count('STEP') !== 1) errors.push(`expected 1 STEP, got ${count('STEP')}`);
  if (count('LLM') < 2) errors.push(`expected ≥2 LLM (request+response), got ${count('LLM')}`);
  if (count('TOOL') % 2 !== 0) errors.push(`expected even TOOL count (call+result pairs), got ${count('TOOL')}`);

  const byKind = (k) => spans.filter((s) => s['gen_ai.span.kind'] === k);
  const entry = byKind('ENTRY')[0];
  const agent = byKind('AGENT')[0];
  const step = byKind('STEP')[0];
  if (entry && agent && agent.parent_span_id !== entry.span_id) {
    errors.push('AGENT.parent_span_id does not match ENTRY.span_id');
  }
  if (agent && step && step.parent_span_id !== agent.span_id) {
    errors.push('STEP.parent_span_id does not match AGENT.span_id');
  }
  for (const s of byKind('LLM')) {
    if (s.parent_span_id !== step.span_id) errors.push(`LLM ${s['event.name']} not under STEP`);
  }
  for (const s of byKind('TOOL')) {
    if (s.parent_span_id !== step.span_id) errors.push(`TOOL ${s['event.name']} not under STEP`);
  }

  // single trace_id
  const traceIds = new Set(spans.map((s) => s.trace_id));
  if (traceIds.size !== 1) errors.push(`expected 1 trace_id, got ${traceIds.size}`);

  // messages non-empty (CLAUDE.md铁律 #5)
  const llmReq = byKind('LLM').find((s) => s['event.name'] === 'llm.request');
  const llmRes = byKind('LLM').find((s) => s['event.name'] === 'llm.response');
  if (llmReq) {
    const msgs = llmReq['gen_ai.input.messages'];
    if (!Array.isArray(msgs) || msgs.length === 0 || !msgs[0]?.parts?.[0]?.content) {
      errors.push('llm.request gen_ai.input.messages is empty');
    }
  }
  if (llmRes) {
    const msgs = llmRes['gen_ai.output.messages'];
    if (!Array.isArray(msgs) || msgs.length === 0 || !msgs[0]?.parts?.[0]?.content) {
      errors.push('llm.response gen_ai.output.messages is empty');
    }
    const fr = llmRes['gen_ai.response.finish_reasons'];
    if (!Array.isArray(fr) || !fr.includes('stop')) {
      errors.push('finish_reasons must include "stop"');
    }
  }

  // tool call/result pairing
  const calls = byKind('TOOL').filter((s) => s['event.name'] === 'tool.call');
  const results = byKind('TOOL').filter((s) => s['event.name'] === 'tool.result');
  const callIds = new Set(calls.map((s) => s['gen_ai.tool.call.id']));
  const resultIds = new Set(results.map((s) => s['gen_ai.tool.call.id']));
  for (const id of resultIds) {
    if (!callIds.has(id)) errors.push(`tool.result ${id} has no matching tool.call`);
  }

  // time ordering
  const ts = spans.map((s) => BigInt(s.time_unix_nano || '0'));
  for (let i = 1; i < ts.length; i += 1) {
    if (ts[i] < ts[i - 1]) warns.push('spans not sorted by time_unix_nano');
  }
}

console.log(`${TAG} file=${values.input}`);
console.log(`${TAG} span_count=${spans.length}`);
console.log(`${TAG} errors=${errors.length} warns=${warns.length}`);
for (const e of errors) console.error(`${TAG} ERROR: ${e}`);
for (const w of warns) console.warn(`${TAG} WARN: ${w}`);
process.exit(errors.length > 0 ? 1 : 0);
