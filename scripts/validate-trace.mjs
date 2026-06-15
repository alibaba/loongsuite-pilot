#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[validate-trace]';
const OTLP_DEBUG_DIR = path.join(homedir(), '.loongsuite-pilot', 'logs', 'otlp-debug');
const VALID_SPAN_KINDS = ['ENTRY', 'AGENT', 'STEP', 'LLM', 'TOOL', 'CHAIN', 'RETRIEVER', 'RERANKER', 'EMBEDDING', 'TASK'];
const KNOWN_SUBAGENT_TOOLS = new Set(['Agent']);
// TODO: remove 'tool_calls' once all producers are migrated to singular 'tool_call'
const VALID_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_call', 'tool_calls', 'error', 'end_turn', 'max_tokens']);
const VALID_PART_TYPES = new Set(['text', 'tool_call', 'tool_call_response', 'reasoning']);

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseCli() {
  const { values } = parseArgs({
    options: {
      input:      { type: 'string', short: 'i' },
      latest:     { type: 'boolean', default: false },
      rules:      { type: 'string', short: 'r', default: path.join(__dirname, '..', 'docs', 'trace-validation-rules.json') },
      format:     { type: 'string', short: 'f', default: 'text' },
      output:     { type: 'string', short: 'o' },
      'trace-id': { type: 'string' },
      severity:   { type: 'string', default: 'warn' },
    },
    strict: true,
  });

  if (!values.input && !values.latest) {
    console.error(`${TAG} error: must specify --input <path> or --latest`);
    process.exit(2);
  }
  if (values.input && values.latest) {
    console.error(`${TAG} error: --input and --latest are mutually exclusive`);
    process.exit(2);
  }
  if (!['json', 'text', 'summary'].includes(values.format)) {
    console.error(`${TAG} error: --format must be json, text, or summary`);
    process.exit(2);
  }
  return values;
}

// ─── File Discovery ──────────────────────────────────────────────────────────

function findLatestJsonl() {
  let files;
  try {
    files = readdirSync(OTLP_DEBUG_DIR).filter(f => f.endsWith('.jsonl'));
  } catch {
    console.error(`${TAG} error: cannot read ${OTLP_DEBUG_DIR}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`${TAG} error: no .jsonl files in ${OTLP_DEBUG_DIR}`);
    process.exit(2);
  }
  files.sort((a, b) => {
    const sa = statSync(path.join(OTLP_DEBUG_DIR, a)).mtimeMs;
    const sb = statSync(path.join(OTLP_DEBUG_DIR, b)).mtimeMs;
    return sb - sa;
  });
  return path.join(OTLP_DEBUG_DIR, files[0]);
}

// ─── JSONL Reader ────────────────────────────────────────────────────────────

function readSpans(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    console.error(`${TAG} error: cannot read ${filePath}`);
    process.exit(2);
  }
  const spans = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj._error) continue;
      spans.push(obj);
    } catch {
      console.error(`${TAG} warning: skipping malformed JSON line`);
    }
  }
  if (spans.length === 0) {
    console.error(`${TAG} error: no valid spans found in ${filePath}`);
    process.exit(2);
  }
  return spans;
}

// ─── Rules Loader ────────────────────────────────────────────────────────────

function loadRules(rulesPath) {
  try {
    return JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (e) {
    console.error(`${TAG} error: cannot load rules from ${rulesPath}: ${e.message}`);
    process.exit(2);
  }
}

// ─── Trace Tree Builder ─────────────────────────────────────────────────────

function buildTraces(spans, traceIdFilter) {
  const grouped = new Map();
  for (const span of spans) {
    if (traceIdFilter && span.traceId !== traceIdFilter) continue;
    if (!grouped.has(span.traceId)) grouped.set(span.traceId, []);
    grouped.get(span.traceId).push(span);
  }

  const traces = [];
  for (const [traceId, traceSpans] of grouped) {
    const spanMap = new Map();
    const childrenMap = new Map();
    for (const s of traceSpans) {
      s._kind = s.attributes?.['gen_ai.span.kind'] || 'UNKNOWN';
      spanMap.set(s.spanId, s);
      if (!childrenMap.has(s.spanId)) childrenMap.set(s.spanId, []);
    }
    for (const s of traceSpans) {
      if (s.parentSpanId && spanMap.has(s.parentSpanId)) {
        childrenMap.get(s.parentSpanId).push(s);
      }
    }

    const hasMessageContent = traceSpans.some(s =>
      s.attributes?.['gen_ai.input.messages'] || s.attributes?.['gen_ai.output.messages']
    );

    const agentSpan = traceSpans.find(s => s._kind === 'AGENT');
    const agentName = agentSpan?.attributes?.['gen_ai.agent.name'] || 'unknown';

    traces.push({ traceId, spans: traceSpans, spanMap, childrenMap, hasMessageContent, agentName });
  }
  return traces;
}

// ─── Check Result Helpers ───────────────────────────────────────────────────

function pass(id, detail) { return { id, status: 'pass', ...(detail ? { detail } : {}) }; }
function error(id, detail, spanId, spanName) { return { id, status: 'error', detail, ...(spanId ? { spanId } : {}), ...(spanName ? { spanName } : {}) }; }
function warn(id, detail, spanId, spanName) { return { id, status: 'warn', detail, ...(spanId ? { spanId } : {}), ...(spanName ? { spanName } : {}) }; }
function skipped(id, reason) { return { id, status: 'skipped', detail: reason || 'captureMessageContent not enabled' }; }

// ─── 5a. Structure Validation ───────────────────────────────────────────────

function validateStructure(trace) {
  const checks = [];
  const { spans, spanMap, childrenMap } = trace;

  const byKind = (kind) => spans.filter(s => s._kind === kind);
  const parentKind = (s) => s.parentSpanId && spanMap.has(s.parentSpanId) ? spanMap.get(s.parentSpanId)._kind : null;

  const entries = byKind('ENTRY');
  checks.push(entries.length === 1
    ? pass('structure.single_entry')
    : error('structure.single_entry', `found ${entries.length} ENTRY spans, expected 1`));

  const agents = byKind('AGENT');
  checks.push(agents.length === 1
    ? pass('structure.single_agent')
    : error('structure.single_agent', `found ${agents.length} AGENT spans, expected 1`));

  if (entries.length === 1) {
    const e = entries[0];
    const isRoot = !e.parentSpanId || !spanMap.has(e.parentSpanId);
    checks.push(isRoot
      ? pass('structure.entry_is_root')
      : error('structure.entry_is_root', 'ENTRY span has a parent within this trace', e.spanId, e.name));
  }

  for (const a of agents) {
    checks.push(parentKind(a) === 'ENTRY'
      ? pass('structure.agent_under_entry')
      : error('structure.agent_under_entry', `AGENT parent is ${parentKind(a) || 'none'}, expected ENTRY`, a.spanId, a.name));
  }

  const steps = byKind('STEP');
  for (const s of steps) {
    const pk = parentKind(s);
    if (pk !== 'AGENT') {
      checks.push(error('structure.step_under_agent', `STEP parent is ${pk || 'none'}, expected AGENT`, s.spanId, s.name));
    }
  }
  if (steps.length > 0 && steps.every(s => parentKind(s) === 'AGENT')) {
    checks.push(pass('structure.step_under_agent'));
  }

  for (const l of byKind('LLM')) {
    const pk = parentKind(l);
    if (pk !== 'STEP') {
      checks.push(error('structure.llm_under_step', `LLM parent is ${pk || 'none'}, expected STEP`, l.spanId, l.name));
    }
  }
  if (byKind('LLM').length > 0 && byKind('LLM').every(l => parentKind(l) === 'STEP')) {
    checks.push(pass('structure.llm_under_step'));
  }

  for (const t of byKind('TOOL')) {
    const pk = parentKind(t);
    if (pk !== 'STEP') {
      checks.push(error('structure.tool_under_step', `TOOL parent is ${pk || 'none'}, expected STEP`, t.spanId, t.name));
    }
  }
  if (byKind('TOOL').length > 0 && byKind('TOOL').every(t => parentKind(t) === 'STEP')) {
    checks.push(pass('structure.tool_under_step'));
  } else if (byKind('TOOL').length === 0) {
    checks.push(pass('structure.tool_under_step'));
  }

  let allStepsOk = true;
  for (const s of steps) {
    const children = childrenMap.get(s.spanId) || [];
    const llmChildren = children.filter(c => c._kind === 'LLM');
    if (llmChildren.length !== 1) {
      checks.push(error('structure.step_has_one_llm', `STEP has ${llmChildren.length} LLM children, expected 1`, s.spanId, s.name));
      allStepsOk = false;
    }
  }
  if (allStepsOk && steps.length > 0) {
    checks.push(pass('structure.step_has_one_llm', `${steps.length} STEPs, each with 1 LLM`));
  }

  let llmOrderOk = true;
  for (const s of steps) {
    const children = childrenMap.get(s.spanId) || [];
    const llm = children.find(c => c._kind === 'LLM');
    const tools = children.filter(c => c._kind === 'TOOL');
    if (llm && tools.length > 0) {
      const llmStart = BigInt(llm.startTimeUnixNano);
      for (const t of tools) {
        if (BigInt(t.startTimeUnixNano) < llmStart) {
          checks.push(error('structure.llm_before_tools', `TOOL ${t.name} starts before LLM`, t.spanId, t.name));
          llmOrderOk = false;
        }
      }
    }
  }
  if (llmOrderOk && steps.length > 0) {
    checks.push(pass('structure.llm_before_tools'));
  }

  if (entries.length === 1) {
    const visited = new Set();
    const queue = [entries[0].spanId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const child of (childrenMap.get(id) || [])) {
        queue.push(child.spanId);
      }
    }
    const orphans = spans.filter(s => !visited.has(s.spanId));
    checks.push(orphans.length === 0
      ? pass('structure.no_orphan_spans')
      : error('structure.no_orphan_spans', `${orphans.length} orphan span(s): ${orphans.map(o => o.spanId.slice(0, 8)).join(', ')}`));
  }

  return checks;
}

// ─── 5b. Attribute Validation ───────────────────────────────────────────────

function validateAttributes(trace, rules) {
  const checks = [];
  const { spans, hasMessageContent } = trace;

  for (const span of spans) {
    const attrs = span.attributes || {};
    const kind = span._kind;
    const sid = span.spanId;
    const sname = span.name;

    for (const attrDef of rules.commonAttributes.must) {
      if (attrs[attrDef.key] === undefined || attrs[attrDef.key] === null || attrs[attrDef.key] === '') {
        checks.push(error(`attr.common.must.${attrDef.key}`, `missing ${attrDef.key}`, sid, sname));
      }
    }
    for (const attrDef of rules.commonAttributes.should) {
      if (attrs[attrDef.key] === undefined || attrs[attrDef.key] === null || attrs[attrDef.key] === '') {
        checks.push(warn(`attr.common.should.${attrDef.key}`, `missing ${attrDef.key}`, sid, sname));
      }
    }

    const kindRules = rules.spanKinds[kind];
    if (!kindRules) continue;

    for (const attrDef of kindRules.attributes.must) {
      const val = attrs[attrDef.key];
      if (val === undefined || val === null) {
        checks.push(error(`attr.${kind}.must.${shortKey(attrDef.key)}`, `missing ${attrDef.key}`, sid, sname));
        continue;
      }
      if (attrDef.expectedValue !== undefined && val !== attrDef.expectedValue) {
        checks.push(error(`attr.${kind}.must.${shortKey(attrDef.key)}`, `${attrDef.key}=${val}, expected ${attrDef.expectedValue}`, sid, sname));
      }
    }

    for (const attrDef of kindRules.attributes.should) {
      if (attrDef.requiresMessageContent && !hasMessageContent) {
        checks.push(skipped(`attr.${kind}.should.${shortKey(attrDef.key)}`));
        continue;
      }
      const val = attrs[attrDef.key];
      if (val === undefined || val === null) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `missing ${attrDef.key}`, sid, sname));
        continue;
      }
      if (attrDef.expectedValue !== undefined && val !== attrDef.expectedValue) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key}=${val}, expected ${attrDef.expectedValue}`, sid, sname));
      }
      if (attrDef.type === 'integer' && !Number.isInteger(val)) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key} is not integer: ${val}`, sid, sname));
      }
      if (attrDef.type === 'integer' && attrDef.min !== undefined && val < attrDef.min) {
        checks.push(warn(`attr.${kind}.should.${shortKey(attrDef.key)}`, `${attrDef.key}=${val} < min ${attrDef.min}`, sid, sname));
      }
    }

    const res = span.resource || {};
    for (const attrDef of rules.resourceAttributes.must) {
      if (!res[attrDef.key]) {
        checks.push(error(`attr.resource.must.${shortKey(attrDef.key)}`, `missing resource ${attrDef.key}`, sid, sname));
      }
    }
    for (const attrDef of rules.resourceAttributes.should) {
      if (!res[attrDef.key]) {
        checks.push(warn(`attr.resource.should.${shortKey(attrDef.key)}`, `missing resource ${attrDef.key}`, sid, sname));
      } else if (attrDef.expectedValue && res[attrDef.key] !== attrDef.expectedValue) {
        checks.push(warn(`attr.resource.should.${shortKey(attrDef.key)}`, `resource ${attrDef.key}=${res[attrDef.key]}, expected ${attrDef.expectedValue}`, sid, sname));
      }
    }
  }

  return checks;
}

function shortKey(key) {
  const parts = key.split('.');
  return parts[parts.length - 1];
}

// ─── 5c. Time Validation ────────────────────────────────────────────────────

function validateTime(trace, rules) {
  const checks = [];
  const { spans, childrenMap } = trace;

  let allNonZero = true;
  for (const s of spans) {
    const start = BigInt(s.startTimeUnixNano);
    const end = BigInt(s.endTimeUnixNano);
    if (end <= start) {
      checks.push(error('time.non_zero_duration', `duration=${Number(end - start) / 1e6}ms`, s.spanId, s.name));
      allNonZero = false;
    }
  }
  if (allNonZero) checks.push(pass('time.non_zero_duration'));

  const steps = spans.filter(s => s._kind === 'STEP');
  const agentSpan = spans.find(s => s._kind === 'AGENT');
  if (agentSpan && steps.length > 1) {
    const sorted = [...steps].sort((a, b) => {
      const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    });
    let overlap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const curEnd = BigInt(sorted[i].endTimeUnixNano);
      const nextStart = BigInt(sorted[i + 1].startTimeUnixNano);
      if (curEnd > nextStart) {
        checks.push(error('time.no_step_overlap',
          `STEP ${sorted[i].spanId.slice(0, 8)} overlaps with ${sorted[i + 1].spanId.slice(0, 8)}`,
          sorted[i].spanId, sorted[i].name));
        overlap = true;
      }
    }
    if (!overlap) checks.push(pass('time.no_step_overlap'));
  } else if (steps.length <= 1) {
    checks.push(pass('time.no_step_overlap'));
  }

  let allContained = true;
  for (const s of spans) {
    const children = childrenMap.get(s.spanId) || [];
    if (children.length === 0) continue;
    const pStart = BigInt(s.startTimeUnixNano);
    const pEnd = BigInt(s.endTimeUnixNano);
    for (const c of children) {
      const cStart = BigInt(c.startTimeUnixNano);
      const cEnd = BigInt(c.endTimeUnixNano);
      if (cStart < pStart || cEnd > pEnd) {
        checks.push(error('time.parent_contains_children',
          `child ${c.name} [${cStart}-${cEnd}] outside parent ${s.name} [${pStart}-${pEnd}]`,
          c.spanId, c.name));
        allContained = false;
      }
    }
  }
  if (allContained) checks.push(pass('time.parent_contains_children'));

  const maxMs = (rules.timeRules.find(r => r.id === 'time.reasonable_duration')?.maxMs) || 600000;
  let allReasonable = true;
  for (const s of spans.filter(s => s._kind === 'LLM')) {
    const durationMs = Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
    if (durationMs > maxMs) {
      checks.push(warn('time.reasonable_duration', `LLM duration=${Math.round(durationMs)}ms > ${maxMs}ms`, s.spanId, s.name));
      allReasonable = false;
    }
  }
  if (allReasonable) checks.push(pass('time.reasonable_duration'));

  if (steps.length > 1) {
    const withRound = steps.filter(s => s.attributes?.['gen_ai.react.round'] !== undefined);
    if (withRound.length > 1) {
      const byTime = [...withRound].sort((a, b) => {
        const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      });
      let chrono = true;
      for (let i = 0; i < byTime.length - 1; i++) {
        const r1 = byTime[i].attributes['gen_ai.react.round'];
        const r2 = byTime[i + 1].attributes['gen_ai.react.round'];
        if (r1 >= r2) {
          checks.push(warn('time.chronological_steps', `round ${r1} before round ${r2} but starts later`));
          chrono = false;
          break;
        }
      }
      if (chrono) checks.push(pass('time.chronological_steps'));
    } else {
      checks.push(pass('time.chronological_steps'));
    }
  } else {
    checks.push(pass('time.chronological_steps'));
  }

  return checks;
}

// ─── 5d. Schema/Format Validation ───────────────────────────────────────────

function validateSchema(trace, rules) {
  const checks = [];
  const { spans, hasMessageContent } = trace;

  for (const s of spans) {
    if (!/^[0-9a-f]{32}$/.test(s.traceId)) {
      checks.push(error('schema.trace_id_format', `traceId=${s.traceId}`, s.spanId, s.name));
    }
    if (!/^[0-9a-f]{16}$/.test(s.spanId)) {
      checks.push(error('schema.span_id_format', `spanId=${s.spanId}`, s.spanId, s.name));
    }
  }
  if (spans.every(s => /^[0-9a-f]{32}$/.test(s.traceId))) checks.push(pass('schema.trace_id_format'));
  if (spans.every(s => /^[0-9a-f]{16}$/.test(s.spanId))) checks.push(pass('schema.span_id_format'));

  let allKindsValid = true;
  for (const s of spans) {
    if (s._kind && !VALID_SPAN_KINDS.includes(s._kind) && s._kind !== 'UNKNOWN') {
      checks.push(error('schema.span_kind_enum', `gen_ai.span.kind=${s._kind}`, s.spanId, s.name));
      allKindsValid = false;
    }
  }
  if (allKindsValid) checks.push(pass('schema.span_kind_enum'));

  const tokenKeys = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens'];
  let allTokensPositive = true;
  let allTokensSumOk = true;
  for (const s of spans) {
    const attrs = s.attributes || {};
    for (const tk of tokenKeys) {
      const v = attrs[tk];
      if (v !== undefined && v !== null) {
        if (!Number.isInteger(v) || v < 0) {
          checks.push(error('schema.tokens_positive', `${tk}=${v} is not a non-negative integer`, s.spanId, s.name));
          allTokensPositive = false;
        }
      }
    }

    const inp = attrs['gen_ai.usage.input_tokens'];
    const out = attrs['gen_ai.usage.output_tokens'];
    const tot = attrs['gen_ai.usage.total_tokens'];
    if (inp !== undefined && out !== undefined && tot !== undefined) {
      if (Number.isInteger(inp) && Number.isInteger(out) && Number.isInteger(tot)) {
        if (tot !== inp + out) {
          checks.push(error('schema.tokens_sum', `total(${tot}) != input(${inp}) + output(${out})`, s.spanId, s.name));
          allTokensSumOk = false;
        }
      }
    }
  }
  if (allTokensPositive) checks.push(pass('schema.tokens_positive'));
  if (allTokensSumOk) checks.push(pass('schema.tokens_sum'));

  for (const s of spans) {
    const attrs = s.attributes || {};
    const fr = attrs['gen_ai.response.finish_reasons'];
    if (fr !== undefined && fr !== null) {
      try {
        const parsed = typeof fr === 'string' ? JSON.parse(fr) : fr;
        if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) {
          checks.push(warn('schema.finish_reasons', `not a string array`, s.spanId, s.name));
        }
      } catch {
        checks.push(warn('schema.finish_reasons', `invalid JSON`, s.spanId, s.name));
      }
    }
  }

  if (hasMessageContent) {
    for (const s of spans) {
      const attrs = s.attributes || {};
      validateMessageField(attrs, 'gen_ai.input.messages', 'schema.input_messages', s, checks);
      validateMessageField(attrs, 'gen_ai.output.messages', 'schema.output_messages', s, checks);
    }
  } else {
    checks.push(skipped('schema.input_messages'));
    checks.push(skipped('schema.output_messages'));
  }

  return checks;
}

function validateMessageField(attrs, key, ruleId, span, checks) {
  const raw = attrs[key];
  if (raw === undefined || raw === null) return;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) {
      checks.push(error(ruleId, `${key} is not an array`, span.spanId, span.name));
      return;
    }
    for (let i = 0; i < parsed.length; i++) {
      const msg = parsed[i];
      if (!msg.role) {
        checks.push(error(ruleId, `${key}[${i}] missing role`, span.spanId, span.name));
      }
      if (ruleId === 'schema.output_messages') {
        if (msg.finish_reason === undefined) {
          checks.push(warn(ruleId, `${key}[${i}] missing finish_reason`, span.spanId, span.name));
        } else if (!VALID_FINISH_REASONS.has(msg.finish_reason)) {
          checks.push(error(ruleId,
            `${key}[${i}] finish_reason="${msg.finish_reason}" is not a valid FinishReason (expected: ${[...VALID_FINISH_REASONS].join(', ')})`,
            span.spanId, span.name));
        }
      }
      if (msg.parts && Array.isArray(msg.parts)) {
        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j];
          if (!part.type) {
            checks.push(error(ruleId, `${key}[${i}].parts[${j}] missing type`, span.spanId, span.name));
            continue;
          }
          if (VALID_PART_TYPES.has(part.type)) {
            if (part.type === 'text' && part.content === undefined) {
              checks.push(error(ruleId, `${key}[${i}].parts[${j}] TextPart missing required "content"`, span.spanId, span.name));
            }
            if (part.type === 'tool_call' && !part.id) {
              checks.push(warn(ruleId, `${key}[${i}].parts[${j}] ToolCallPart missing "id"`, span.spanId, span.name));
            }
            if (part.type === 'tool_call_response' && !part.id) {
              checks.push(warn(ruleId, `${key}[${i}].parts[${j}] ToolCallResponsePart missing "id"`, span.spanId, span.name));
            }
          } else {
            checks.push(warn(ruleId, `${key}[${i}].parts[${j}] unknown part type="${part.type}"`, span.spanId, span.name));
          }
        }
      }
    }
  } catch {
    checks.push(error(ruleId, `${key} is not valid JSON`, span.spanId, span.name));
  }
}

// ─── 5e. Semantic Validation ────────────────────────────────────────────────

function validateSemantic(trace, rules) {
  const checks = [];
  const { spans, childrenMap, hasMessageContent } = trace;

  // consistent_session_id
  const sessionIds = new Set(spans.map(s => s.attributes?.['gen_ai.session.id']).filter(Boolean));
  checks.push(sessionIds.size <= 1
    ? pass('semantic.consistent_session_id')
    : error('semantic.consistent_session_id', `found ${sessionIds.size} distinct session IDs: ${[...sessionIds].join(', ')}`));

  // consistent_user_id
  const userIds = new Set(spans.map(s => s.attributes?.['gen_ai.user.id']).filter(Boolean));
  checks.push(userIds.size <= 1
    ? pass('semantic.consistent_user_id')
    : error('semantic.consistent_user_id', `found ${userIds.size} distinct user IDs`));

  // consistent_agent_name
  const agentNames = new Set(spans.map(s => s.attributes?.['gen_ai.agent.name']).filter(Boolean));
  checks.push(agentNames.size <= 1
    ? pass('semantic.consistent_agent_name')
    : warn('semantic.consistent_agent_name', `found ${agentNames.size} distinct agent names: ${[...agentNames].join(', ')}`));

  // operation_kind_mapping
  const mapping = rules.operationKindMapping || {};
  let allMappingOk = true;
  for (const s of spans) {
    const opName = s.attributes?.['gen_ai.operation.name'];
    const spanKind = s._kind;
    if (opName && mapping[opName] && mapping[opName] !== spanKind) {
      checks.push(error('semantic.operation_kind_mapping',
        `operation=${opName} maps to ${mapping[opName]}, but span.kind=${spanKind}`, s.spanId, s.name));
      allMappingOk = false;
    }
  }
  if (allMappingOk) checks.push(pass('semantic.operation_kind_mapping'));

  // span_name_pattern
  let allNamesOk = true;
  for (const s of spans) {
    const kindRules = rules.spanKinds[s._kind];
    if (!kindRules?.namePattern) continue;
    const pattern = kindRules.namePattern;
    if (!pattern.includes('{')) {
      if (s.name !== pattern && !s.name.startsWith(pattern)) {
        checks.push(warn('semantic.span_name_pattern', `name="${s.name}", expected pattern "${pattern}"`, s.spanId, s.name));
        allNamesOk = false;
      }
    }
  }
  if (allNamesOk) checks.push(pass('semantic.span_name_pattern'));

  // agent_token_sum
  const agentSpan = spans.find(s => s._kind === 'AGENT');
  if (agentSpan) {
    const llmSpans = spans.filter(s => s._kind === 'LLM');
    for (const tokenKey of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens']) {
      const agentVal = agentSpan.attributes?.[tokenKey];
      if (agentVal === undefined || agentVal === null) continue;
      const llmSum = llmSpans.reduce((sum, l) => sum + (l.attributes?.[tokenKey] || 0), 0);
      if (agentVal !== llmSum) {
        checks.push(error('semantic.agent_token_sum',
          `AGENT ${tokenKey}=${agentVal}, sum of LLM=${llmSum}`, agentSpan.spanId, agentSpan.name));
      }
    }
    const hasAnyToken = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens']
      .some(k => agentSpan.attributes?.[k] !== undefined);
    if (hasAnyToken) {
      const allMatch = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens'].every(k => {
        const av = agentSpan.attributes?.[k];
        if (av === undefined || av === null) return true;
        const llmSum = llmSpans.reduce((sum, l) => sum + (l.attributes?.[k] || 0), 0);
        return av === llmSum;
      });
      if (allMatch) checks.push(pass('semantic.agent_token_sum'));
    }
  }

  // tool_matches_llm_output
  if (!hasMessageContent) {
    checks.push(skipped('semantic.tool_matches_llm_output'));
  } else {
    let allToolsMatch = true;
    const stepSpans = spans.filter(s => s._kind === 'STEP');
    for (const step of stepSpans) {
      const children = childrenMap.get(step.spanId) || [];
      const llm = children.find(c => c._kind === 'LLM');
      const tools = children.filter(c => c._kind === 'TOOL');
      if (!llm || tools.length === 0) continue;

      const outputRaw = llm.attributes?.['gen_ai.output.messages'];
      if (!outputRaw) continue;

      let expectedToolCalls = [];
      try {
        const output = typeof outputRaw === 'string' ? JSON.parse(outputRaw) : outputRaw;
        if (Array.isArray(output)) {
          for (const msg of output) {
            if (msg.parts && Array.isArray(msg.parts)) {
              for (const part of msg.parts) {
                if (part.type === 'tool_call') {
                  expectedToolCalls.push({ id: part.id, name: part.name });
                }
              }
            }
          }
        }
      } catch { continue; }

      for (const tool of tools) {
        const toolCallId = tool.attributes?.['gen_ai.tool.call.id'];
        const toolName = tool.attributes?.['gen_ai.tool.name'];
        const matched = expectedToolCalls.some(tc =>
          (toolCallId && tc.id && tc.id === toolCallId) || (toolName && tc.name && tc.name === toolName)
        );
        if (!matched) {
          checks.push(error('semantic.tool_matches_llm_output',
            `TOOL ${toolName || toolCallId} not found in LLM output tool_calls`, tool.spanId, tool.name));
          allToolsMatch = false;
        }
      }

      for (const tc of expectedToolCalls) {
        const matched = tools.some(t =>
          (tc.id && t.attributes?.['gen_ai.tool.call.id'] === tc.id) ||
          (tc.name && t.attributes?.['gen_ai.tool.name'] === tc.name)
        );
        if (!matched) {
          if (KNOWN_SUBAGENT_TOOLS.has(tc.name)) {
            checks.push(warn('semantic.tool_matches_llm_output',
              `LLM declared subagent tool_call ${tc.name} — subagent TOOL span not yet supported`, llm.spanId, llm.name));
          } else {
            checks.push(error('semantic.tool_matches_llm_output',
              `LLM declared tool_call ${tc.name || tc.id} but no matching TOOL span`, llm.spanId, llm.name));
            allToolsMatch = false;
          }
        }
      }
    }
    if (allToolsMatch) checks.push(pass('semantic.tool_matches_llm_output'));
  }

  // entry_input_exists
  if (!hasMessageContent) {
    checks.push(skipped('semantic.entry_input_exists'));
  } else {
    const entry = spans.find(s => s._kind === 'ENTRY');
    if (entry) {
      const raw = entry.attributes?.['gen_ai.input.messages'];
      if (raw) {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          checks.push(Array.isArray(parsed) && parsed.length > 0
            ? pass('semantic.entry_input_exists')
            : warn('semantic.entry_input_exists', 'ENTRY input.messages is empty'));
        } catch {
          checks.push(warn('semantic.entry_input_exists', 'ENTRY input.messages is not valid JSON'));
        }
      } else {
        checks.push(warn('semantic.entry_input_exists', 'ENTRY missing input.messages'));
      }
    }
  }

  // entry_output_matches
  if (!hasMessageContent) {
    checks.push(skipped('semantic.entry_output_matches'));
  } else {
    const entry = spans.find(s => s._kind === 'ENTRY');
    const llmSpans = spans.filter(s => s._kind === 'LLM');
    if (entry && llmSpans.length > 0) {
      const lastLlm = llmSpans.sort((a, b) => {
        const d = BigInt(a.endTimeUnixNano) - BigInt(b.endTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      })[llmSpans.length - 1];

      const entryOutput = entry.attributes?.['gen_ai.output.messages'];
      const llmOutput = lastLlm.attributes?.['gen_ai.output.messages'];
      if (entryOutput && llmOutput) {
        const eq = JSON.stringify(entryOutput) === JSON.stringify(llmOutput);
        checks.push(eq
          ? pass('semantic.entry_output_matches')
          : warn('semantic.entry_output_matches', 'ENTRY output.messages differs from last LLM output'));
      }
    }
  }

  // llm_has_input_output
  if (!hasMessageContent) {
    checks.push(skipped('semantic.llm_has_input_output'));
  } else {
    let allOk = true;
    for (const s of spans.filter(s => s._kind === 'LLM')) {
      const hasInput = s.attributes?.['gen_ai.input.messages'] !== undefined;
      const hasOutput = s.attributes?.['gen_ai.output.messages'] !== undefined;
      if (!hasInput || !hasOutput) {
        checks.push(error('semantic.llm_has_input_output',
          `LLM missing ${!hasInput ? 'input' : ''}${!hasInput && !hasOutput ? ' and ' : ''}${!hasOutput ? 'output' : ''}.messages`,
          s.spanId, s.name));
        allOk = false;
      }
    }
    if (allOk) checks.push(pass('semantic.llm_has_input_output'));
  }

  // tool_response_role: input.messages with tool_call_response parts must have role=tool
  if (!hasMessageContent) {
    checks.push(skipped('semantic.tool_response_role'));
  } else {
    let allRolesOk = true;
    for (const s of spans.filter(s => s._kind === 'LLM')) {
      const raw = s.attributes?.['gen_ai.input.messages'];
      if (!raw) continue;
      try {
        const msgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          const parts = msg.parts;
          if (!Array.isArray(parts)) continue;
          const hasToolResponse = parts.some(p => p.type === 'tool_call_response');
          if (hasToolResponse && msg.role !== 'tool') {
            checks.push(error('semantic.tool_response_role',
              `input.messages role='${msg.role}' but contains tool_call_response part, expected role='tool'`,
              s.spanId, s.name));
            allRolesOk = false;
          }
        }
      } catch { /* skip parse errors */ }
    }
    if (allRolesOk) checks.push(pass('semantic.tool_response_role'));
  }

  // tool_has_arguments: TOOL spans should have gen_ai.tool.call.arguments
  {
    const toolSpans = spans.filter(s => s._kind === 'TOOL');
    let allHaveArgs = true;
    for (const t of toolSpans) {
      const args = t.attributes?.['gen_ai.tool.call.arguments'];
      if (args === undefined || args === null || args === '') {
        checks.push(error('semantic.tool_has_arguments',
          `TOOL ${t.attributes?.['gen_ai.tool.name'] || t.name} missing gen_ai.tool.call.arguments`,
          t.spanId, t.name));
        allHaveArgs = false;
      }
    }
    if (allHaveArgs && toolSpans.length > 0) checks.push(pass('semantic.tool_has_arguments'));
    if (toolSpans.length === 0) checks.push(pass('semantic.tool_has_arguments'));
  }

  // last_step_no_tool_call: last STEP's LLM output should not contain tool_call
  if (!hasMessageContent) {
    checks.push(skipped('semantic.last_step_no_tool_call'));
  } else {
    const stepSpans = spans.filter(s => s._kind === 'STEP');
    if (stepSpans.length > 0) {
      const sorted = [...stepSpans].sort((a, b) => {
        const d = BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano);
        return d < 0n ? -1 : d > 0n ? 1 : 0;
      });
      const lastStep = sorted[sorted.length - 1];
      const children = childrenMap.get(lastStep.spanId) || [];
      const llm = children.find(c => c._kind === 'LLM');
      if (llm) {
        const raw = llm.attributes?.['gen_ai.output.messages'];
        if (raw) {
          try {
            const msgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
            let hasToolCall = false;
            if (Array.isArray(msgs)) {
              for (const msg of msgs) {
                if (Array.isArray(msg.parts)) {
                  for (const part of msg.parts) {
                    if (part.type === 'tool_call') hasToolCall = true;
                  }
                }
              }
            }
            checks.push(hasToolCall
              ? error('semantic.last_step_no_tool_call',
                  'last STEP LLM output contains tool_call, expected final answer without tool calls',
                  llm.spanId, llm.name)
              : pass('semantic.last_step_no_tool_call'));
          } catch {
            checks.push(pass('semantic.last_step_no_tool_call'));
          }
        } else {
          checks.push(pass('semantic.last_step_no_tool_call'));
        }
      }
    }
  }

  return checks;
}

// ─── Report Formatters ──────────────────────────────────────────────────────

function buildReport(traces, inputFile, rules, severityFilter) {
  const traceReports = [];
  let totalSpans = 0;
  const totalChecks = { total: 0, pass: 0, warn: 0, error: 0, skipped: 0 };

  for (const trace of traces) {
    const allChecks = [
      ...validateStructure(trace),
      ...validateAttributes(trace, rules),
      ...validateTime(trace, rules),
      ...validateSchema(trace, rules),
      ...validateSemantic(trace, rules),
    ];

    const deduped = deduplicateChecks(allChecks);
    const filtered = filterBySeverity(deduped, severityFilter);

    const counts = { entry: 0, agent: 0, steps: 0, llms: 0, tools: 0, other: 0 };
    for (const s of trace.spans) {
      switch (s._kind) {
        case 'ENTRY': counts.entry++; break;
        case 'AGENT': counts.agent++; break;
        case 'STEP':  counts.steps++; break;
        case 'LLM':   counts.llms++;  break;
        case 'TOOL':  counts.tools++; break;
        default:       counts.other++; break;
      }
    }

    const hasError = filtered.some(c => c.status === 'error');

    for (const c of filtered) {
      totalChecks.total++;
      totalChecks[c.status]++;
    }
    totalSpans += trace.spans.length;

    traceReports.push({
      traceId: trace.traceId,
      agent: trace.agentName,
      spans: trace.spans.length,
      structure: counts,
      verdict: hasError ? 'FAIL' : 'PASS',
      checks: filtered,
    });
  }

  const verdict = totalChecks.error > 0 ? 'FAIL' : 'PASS';

  return {
    meta: {
      tool: 'validate-trace',
      version: rules.version,
      rulesVersion: rules.version,
      timestamp: new Date().toISOString(),
      input: path.basename(inputFile),
      captureMessageContent: traces.some(t => t.hasMessageContent),
    },
    summary: {
      traces: traces.length,
      spans: totalSpans,
      checks: totalChecks,
      verdict,
    },
    traces: traceReports,
  };
}

function deduplicateChecks(checks) {
  const seen = new Map();
  const result = [];
  for (const c of checks) {
    const key = `${c.id}:${c.spanId || ''}:${c.status}`;
    if (c.status === 'pass') {
      if (!seen.has(c.id)) {
        seen.set(c.id, true);
        result.push(c);
      }
    } else {
      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(c);
      }
    }
  }
  return result;
}

function filterBySeverity(checks, severity) {
  const levels = { error: 0, warn: 1, info: 2 };
  const statusToLevel = { error: 0, warn: 1, pass: 2, skipped: 2 };
  const minLevel = levels[severity] ?? 1;
  return checks.filter(c => (statusToLevel[c.status] ?? 2) <= minLevel || c.status === 'pass' || c.status === 'skipped');
}

function formatText(report) {
  const lines = [];
  const mc = report.meta.captureMessageContent ? 'enabled' : 'disabled';
  lines.push('');
  lines.push('╔' + '═'.repeat(62) + '╗');
  lines.push('║  GenAI Trace Validation Report' + ' '.repeat(32) + '║');
  lines.push('║  Input: ' + report.meta.input.padEnd(53) + '║');
  lines.push('║  Rules: v' + report.meta.rulesVersion.padEnd(52) + '║');
  lines.push('║  Message Content: ' + mc.padEnd(43) + '║');
  lines.push('╚' + '═'.repeat(62) + '╝');
  lines.push('');

  for (const t of report.traces) {
    lines.push(`Trace ${t.traceId.slice(0, 12)}... (${t.agent}, ${t.spans} spans)`);
    const s = t.structure;
    lines.push(`  Structure: ${s.entry} ENTRY, ${s.agent} AGENT, ${s.steps} STEPs, ${s.llms} LLMs, ${s.tools} TOOLs`);

    for (const c of t.checks) {
      const icon = c.status === 'pass' ? '✅' : c.status === 'error' ? '❌' : c.status === 'warn' ? '⚠️ ' : '⏭️ ';
      const detail = c.detail ? ` — ${c.detail}` : '';
      const span = c.spanId ? ` [${c.spanId.slice(0, 8)}]` : '';
      lines.push(`  ${icon} ${c.id}${span}${detail}`);
    }
    lines.push('');
    lines.push('─'.repeat(50));
    lines.push('');
  }

  const ck = report.summary.checks;
  lines.push(`Summary: ${report.summary.traces} traces, ${report.summary.spans} spans`);
  lines.push(`  ✅ Pass: ${ck.pass}  ⚠️  Warn: ${ck.warn}  ❌ Error: ${ck.error}  ⏭️  Skipped: ${ck.skipped}`);
  lines.push(`  Verdict: ${report.summary.verdict}`);
  lines.push('');
  return lines.join('\n');
}

function formatSummary(report) {
  const ck = report.summary.checks;
  const icon = ck.error > 0 ? '❌' : '✅';
  return `${icon} ${report.summary.traces} traces, ${report.summary.spans} spans, ${ck.error} errors, ${ck.warn} warnings, ${ck.skipped} skipped`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseCli();

  const inputFile = opts.latest ? findLatestJsonl() : opts.input;
  console.error(`${TAG} validating: ${inputFile}`);

  const spans = readSpans(inputFile);
  console.error(`${TAG} loaded ${spans.length} spans`);

  const rules = loadRules(opts.rules);
  const traces = buildTraces(spans, opts['trace-id']);

  if (traces.length === 0) {
    console.error(`${TAG} error: no traces found${opts['trace-id'] ? ` for trace-id ${opts['trace-id']}` : ''}`);
    process.exit(2);
  }
  console.error(`${TAG} found ${traces.length} trace(s)`);

  const report = buildReport(traces, inputFile, rules, opts.severity);

  let output;
  switch (opts.format) {
    case 'json':
      output = JSON.stringify(report, null, 2);
      break;
    case 'summary':
      output = formatSummary(report);
      break;
    default:
      output = formatText(report);
  }

  if (opts.output) {
    writeFileSync(opts.output, output, 'utf8');
    console.error(`${TAG} report written to ${opts.output}`);
  } else {
    console.log(output);
  }

  process.exit(report.summary.verdict === 'FAIL' ? 1 : 0);
}

main();
