#!/usr/bin/env node

/**
 * Parse gen-ai.md from local file or GitLab API and generate/update
 * docs/trace-validation-rules.json.
 *
 * Usage:
 *   node scripts/update-validation-rules.mjs --spec-file <path>
 *   node scripts/update-validation-rules.mjs --spec-url <gitlab-raw-url>
 *   node scripts/update-validation-rules.mjs                  (default: local arms/ copy)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[update-rules]';
const DEFAULT_SPEC = path.resolve(__dirname, '..', '..', 'arms', 'semantic-conventions', 'arms_docs', 'trace', 'gen-ai.md');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'docs', 'trace-validation-rules.json');

// ─── CLI ─────────────────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  options: {
    'spec-file': { type: 'string' },
    'spec-url':  { type: 'string' },
    output:      { type: 'string', short: 'o', default: OUTPUT_PATH },
    diff:        { type: 'boolean', default: false },
  },
  strict: true,
});

// ─── Fetch spec content ─────────────────────────────────────────────────────

async function fetchSpec() {
  if (opts['spec-url']) {
    console.log(`${TAG} fetching from URL: ${opts['spec-url']}`);
    const res = await fetch(opts['spec-url']);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
  }
  const filePath = opts['spec-file'] || DEFAULT_SPEC;
  if (!existsSync(filePath)) {
    console.error(`${TAG} error: spec file not found: ${filePath}`);
    process.exit(2);
  }
  console.log(`${TAG} reading local spec: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

// ─── Markdown Parser ────────────────────────────────────────────────────────

const SECTION_MAP = {
  '公共部分':    'COMMON',
  'Chain':       'CHAIN',
  'Retriever':   'RETRIEVER',
  'Reranker':    'RERANKER',
  'LLM':         'LLM',
  'Embedding':   'EMBEDDING',
  'Tool':        'TOOL',
  'Agent':       'AGENT',
  'Task':        'TASK',
  'Entry':       'ENTRY',
  'ReAct Step':  'STEP',
};

const RESOURCE_SECTION = '## Resources';

const LEVEL_MAP = {
  '必须':          'must',
  '有条件时必须':  'should',
  '推荐':          'should',
  '可选':          'optional',
};

function parseSpec(md) {
  const lines = md.split('\n');
  const sections = {};
  let currentSection = null;
  let inAttrTable = false;
  let inResourceTable = false;
  let headerCols = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect top-level section: "# SectionName"
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      const name = h1[1].trim();
      const mapped = SECTION_MAP[name];
      if (mapped) {
        currentSection = mapped;
        if (!sections[currentSection]) sections[currentSection] = { attrs: [], resources: [] };
      } else {
        currentSection = null;
      }
      inAttrTable = false;
      inResourceTable = false;
      continue;
    }

    // Detect "## Resources" sub-section
    if (line.trim() === '## Resources') {
      inResourceTable = true;
      inAttrTable = false;
      continue;
    }
    if (line.trim() === '## Attributes') {
      inAttrTable = true;
      inResourceTable = false;
      continue;
    }
    if (line.startsWith('## ') && line.trim() !== '## Attributes' && line.trim() !== '## Resources') {
      inAttrTable = false;
      inResourceTable = false;
      continue;
    }

    // Parse table header
    if ((inAttrTable || inResourceTable) && (line.includes('AttributeKey') || line.includes('ResourceKey'))) {
      headerCols = line.split('|').map(c => c.trim()).filter(Boolean);
      continue;
    }
    // Skip separator line
    if (line.match(/^\|\s*---/)) continue;

    // Parse table data row
    if ((inAttrTable || inResourceTable) && line.startsWith('|') && currentSection) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 4) continue;

      const key = cols[0].replace(/`/g, '').replace(/\s*\[.*\]/, '').trim();
      if (!key || key === '---') continue;

      const typeStr = cols[2]?.toLowerCase().trim() || 'string';

      // Find the requirement level — scan columns from right to look for known level strings
      // This handles tables with missing columns (e.g. gen_ai.tool.name has no Example column)
      let levelStr = '';
      for (let ci = 3; ci < cols.length; ci++) {
        const val = cols[ci].trim();
        if (LEVEL_MAP[val]) { levelStr = val; break; }
      }
      // Also check if cols[4] is a known level (standard 6-column table)
      if (!levelStr && cols[4] && LEVEL_MAP[cols[4].trim()]) {
        levelStr = cols[4].trim();
      }

      const level = LEVEL_MAP[levelStr];
      if (!level) continue;

      // Extract expected value from Example column (cols[3] in standard 6-col tables)
      const example = cols[3]?.replace(/`/g, '').trim() || '';
      const isExampleALevel = !!LEVEL_MAP[example];

      const attr = { key, type: normalizeType(typeStr) };

      // Determine expectedValue for span.kind fields
      if (key === 'gen_ai.span.kind') {
        if (!isExampleALevel && example && SECTION_MAP[example] !== undefined) {
          attr.expectedValue = example;
        } else {
          const kindFromSection = currentSection;
          if (kindFromSection !== 'COMMON') attr.expectedValue = kindFromSection;
        }
      }

      attr.level = level;

      if (inResourceTable) {
        sections[currentSection].resources.push(attr);
      } else {
        sections[currentSection].attrs.push(attr);
      }
    }
  }

  return sections;
}

function normalizeType(t) {
  if (t.includes('int')) return 'integer';
  if (t.includes('float') || t.includes('double')) return 'number';
  if (t.includes('string[]')) return 'string_array';
  return 'string';
}

// ─── Operation-Kind Mapping Parser ──────────────────────────────────────────

function parseOperationKindMapping(md) {
  const mapping = {};
  const lines = md.split('\n');
  let inMappingTable = false;

  for (const line of lines) {
    if (line.includes('`gen_ai.span.kind`') && line.includes('`gen_ai.operation.name`') && line.includes('Description')) {
      inMappingTable = true;
      continue;
    }
    if (inMappingTable && line.match(/^\|\s*---/)) continue;
    if (inMappingTable && line.startsWith('|')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 3) { inMappingTable = false; continue; }
      const spanKind = cols[0].trim();
      const opNames = cols[1].replace(/`/g, '').split(';').map(s => s.trim()).filter(s => s && s !== '-');
      for (const op of opNames) {
        mapping[op] = spanKind;
      }
    } else if (inMappingTable && !line.startsWith('|')) {
      inMappingTable = false;
    }
  }

  // Add known non-standard mappings
  if (!mapping['enter']) mapping['enter'] = 'ENTRY';
  if (!mapping['react']) mapping['react'] = 'STEP';
  if (!mapping['run_task']) mapping['run_task'] = 'TASK';
  if (!mapping['workflow']) mapping['workflow'] = 'CHAIN';
  if (!mapping['task']) mapping['task'] = 'CHAIN';
  if (!mapping['rerank']) mapping['rerank'] = 'RERANKER';

  return mapping;
}

// ─── Build Rules JSON ───────────────────────────────────────────────────────

// Overrides: design decisions that deviate from the raw spec levels
const LEVEL_OVERRIDES = {
  // Per design doc: these are MUST on ALL spans
  'gen_ai.session.id': 'must',
  'gen_ai.user.id': 'must',
  'gen_ai.agent.name': 'must',
  // Per design doc: tool.name is MUST for TOOL spans
  'TOOL:gen_ai.tool.name': 'must',
  // Per design doc: agent.name is MUST on AGENT span
  'AGENT:gen_ai.agent.name': 'must',
};

// Attributes that belong to per-kind rules, not common (even though they appear in the common table)
const PER_KIND_ONLY_KEYS = new Set([
  'gen_ai.span.kind',
  'gen_ai.operation.name',
]);

// Attributes that the spec marks as "可选" but the design doc elevates to SHOULD
const OPTIONAL_TO_SHOULD = {
  'RERANKER:reranker.query': true,
  'RERANKER:reranker.model_name': true,
  'RERANKER:reranker.top_k': true,
  'RETRIEVER:gen_ai.retrieval.documents': true,
  'RETRIEVER:gen_ai.retrieval.query.text': true,
  'TASK:input.value': true,
  'TASK:input.mime_type': true,
  'TASK:output.value': true,
  'TASK:output.mime_type': true,
  'EMBEDDING:gen_ai.usage.input_tokens': true,
  'EMBEDDING:gen_ai.usage.total_tokens': true,
};

// Attributes that require captureMessageContent
const MESSAGE_CONTENT_KEYS = new Set([
  'gen_ai.input.messages', 'gen_ai.output.messages',
  'gen_ai.system_instructions', 'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'gen_ai.input.multimodal_metadata', 'gen_ai.output.multimodal_metadata',
]);

// Schema mappings for known attributes
const SCHEMA_MAP = {
  'gen_ai.input.messages': 'input_messages',
  'gen_ai.output.messages': 'output_messages',
  'gen_ai.system_instructions': 'system_instructions',
  'gen_ai.tool.definitions': 'tool_definitions',
  'gen_ai.retrieval.documents': 'retrieval_documents',
};

// Span kind metadata from design doc (these are structural, not derivable from the attribute tables)
const SPAN_KIND_META = {
  ENTRY:     { namePattern: 'enter_ai_application_system', operationName: 'enter', multiplicity: 'exactly_one', parentKind: null, allowedChildren: ['AGENT'] },
  AGENT:     { namePattern: '{gen_ai.operation.name} {gen_ai.agent.name}', operationName: ['invoke_agent', 'create_agent'], multiplicity: 'exactly_one', parentKind: 'ENTRY', allowedChildren: ['STEP'],
               aggregation: { 'gen_ai.usage.input_tokens': { rule: 'sum', source: 'LLM' }, 'gen_ai.usage.output_tokens': { rule: 'sum', source: 'LLM' }, 'gen_ai.usage.total_tokens': { rule: 'sum', source: 'LLM' } } },
  STEP:      { namePattern: 'react step', operationName: 'react', multiplicity: 'one_or_more', parentKind: 'AGENT', allowedChildren: ['LLM', 'TOOL'],
               constraints: [{ rule: 'exactly_one_child_of_kind', kind: 'LLM' }, { rule: 'llm_starts_before_all_tools' }, { rule: 'no_time_overlap_between_siblings' }] },
  LLM:       { namePattern: '{gen_ai.operation.name} {gen_ai.request.model}', operationName: ['chat', 'generate_content', 'text_completion'], multiplicity: 'one_or_more', parentKind: 'STEP', allowedChildren: [] },
  TOOL:      { namePattern: 'execute_tool {gen_ai.tool.name}', operationName: 'execute_tool', multiplicity: 'zero_or_more', parentKind: 'STEP', allowedChildren: [] },
  CHAIN:     { namePattern: 'chain {chain_name}', operationName: ['workflow', 'task'], multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  RETRIEVER: { namePattern: '{gen_ai.operation.name} {gen_ai.data_source.id}', operationName: 'retrieval', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  RERANKER:  { namePattern: 'rerank {reranker.model_name}', operationName: 'rerank', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  EMBEDDING: { namePattern: '{gen_ai.operation.name} {gen_ai.request.model}', operationName: 'embeddings', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
  TASK:      { namePattern: 'run_task {gen_ai.task.name}', operationName: 'run_task', multiplicity: 'zero_or_more', parentKind: null, allowedChildren: [] },
};

function buildRulesJson(sections, operationKindMapping) {
  // Common attributes (exclude per-kind-only keys)
  const commonRaw = sections['COMMON']?.attrs || [];
  const commonMust = [];
  const commonShould = [];
  for (const a of commonRaw) {
    if (PER_KIND_ONLY_KEYS.has(a.key)) continue;
    const overrideLevel = LEVEL_OVERRIDES[a.key];
    const level = overrideLevel || a.level;
    if (level === 'must') commonMust.push(buildAttrEntry(a, null));
    else if (level === 'should') commonShould.push(buildAttrEntry(a, null));
  }

  // Span kinds
  const spanKinds = {};
  for (const [kind, meta] of Object.entries(SPAN_KIND_META)) {
    const sectionAttrs = sections[kind]?.attrs || [];
    const must = [];
    const should = [];

    for (const a of sectionAttrs) {
      const overrideLevel = LEVEL_OVERRIDES[`${kind}:${a.key}`] || LEVEL_OVERRIDES[a.key];
      let level = overrideLevel || a.level;
      // Elevate optional→should for specific attributes per design doc
      if (level === 'optional' && OPTIONAL_TO_SHOULD[`${kind}:${a.key}`]) level = 'should';
      const entry = buildAttrEntry(a, kind);

      if (level === 'must') must.push(entry);
      else if (level === 'should') should.push(entry);
    }

    const kindDef = { ...meta, attributes: { must, should } };
    if (meta.aggregation) kindDef.aggregation = meta.aggregation;
    if (meta.constraints) kindDef.constraints = meta.constraints;
    spanKinds[kind] = kindDef;
  }

  // Resource attributes
  const resourceRaw = sections['COMMON']?.resources || [];
  const resMust = [];
  const resShould = [];
  for (const a of resourceRaw) {
    const entry = { key: a.key, type: a.type };
    if (a.expectedValue) entry.expectedValue = a.expectedValue;
    if (a.level === 'must') resMust.push(entry);
    else if (a.level === 'should') resShould.push(entry);
  }
  // Ensure service.name is always must
  if (!resMust.some(r => r.key === 'service.name')) {
    resMust.push({ key: 'service.name', type: 'string' });
  }
  // Ensure acs.arms.service.feature is should
  if (!resShould.some(r => r.key === 'acs.arms.service.feature')) {
    resShould.push({ key: 'acs.arms.service.feature', type: 'string', expectedValue: 'genai_app' });
  }

  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    specSource: 'docs/EVENT_LOG_TO_TRACE_SPEC.md',

    commonAttributes: { must: commonMust, should: commonShould },
    spanKinds,
    operationKindMapping,

    timeRules: [
      { id: 'time.non_zero_duration', applies: 'all', severity: 'error' },
      { id: 'time.no_step_overlap', applies: 'STEP', severity: 'error' },
      { id: 'time.parent_contains_children', applies: 'all', severity: 'error', toleranceMs: 0 },
      { id: 'time.reasonable_duration', applies: 'LLM', maxMs: 600000, severity: 'warn' },
      { id: 'time.chronological_steps', applies: 'STEP', severity: 'warn' },
    ],

    semanticRules: [
      { id: 'semantic.agent_token_sum', severity: 'error' },
      { id: 'semantic.tool_matches_llm_output', severity: 'error', requiresMessageContent: true },
      { id: 'semantic.entry_input_exists', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.entry_output_matches', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.consistent_session_id', severity: 'error' },
      { id: 'semantic.consistent_user_id', severity: 'error' },
      { id: 'semantic.consistent_agent_name', severity: 'warn' },
      { id: 'semantic.llm_has_input_output', severity: 'warn', requiresMessageContent: true },
      { id: 'semantic.operation_kind_mapping', severity: 'error' },
      { id: 'semantic.span_name_pattern', severity: 'warn' },
      { id: 'semantic.tool_response_role', severity: 'error', requiresMessageContent: true },
      { id: 'semantic.last_step_no_tool_call', severity: 'error', requiresMessageContent: true },
    ],

    resourceAttributes: { must: resMust, should: resShould },

    messageSchemas: {
      input_messages: '$ref:tests/schemas/gen-ai-input-messages.json',
      output_messages: '$ref:tests/schemas/gen-ai-output-messages.json',
      system_instructions: '$ref:tests/schemas/gen-ai-system_instructions.json',
      tool_definitions: '$ref:tests/schemas/gen-ai-tool-definitions.json',
      retrieval_documents: '$ref:tests/schemas/gen-ai-retrieval-documents.json',
    },
  };
}

function buildAttrEntry(raw, spanKind) {
  const entry = { key: raw.key, type: raw.type };
  if (raw.expectedValue) entry.expectedValue = raw.expectedValue;
  if (raw.type === 'integer') entry.min = 0;
  if (SCHEMA_MAP[raw.key]) { entry.schema = SCHEMA_MAP[raw.key]; }
  if (MESSAGE_CONTENT_KEYS.has(raw.key)) entry.requiresMessageContent = true;
  return entry;
}

// ─── Diff ───────────────────────────────────────────────────────────────────

function diffRules(oldRules, newRules) {
  const changes = [];

  // Compare span kinds
  for (const kind of new Set([...Object.keys(oldRules.spanKinds || {}), ...Object.keys(newRules.spanKinds || {})])) {
    const oldK = oldRules.spanKinds?.[kind];
    const newK = newRules.spanKinds?.[kind];
    if (!oldK && newK) { changes.push(`+ added span kind: ${kind}`); continue; }
    if (oldK && !newK) { changes.push(`- removed span kind: ${kind}`); continue; }

    const oldKeys = new Set([...oldK.attributes.must.map(a => a.key), ...oldK.attributes.should.map(a => a.key)]);
    const newKeys = new Set([...newK.attributes.must.map(a => a.key), ...newK.attributes.should.map(a => a.key)]);
    for (const k of newKeys) { if (!oldKeys.has(k)) changes.push(`+ ${kind}: added attribute ${k}`); }
    for (const k of oldKeys) { if (!newKeys.has(k)) changes.push(`- ${kind}: removed attribute ${k}`); }

    const oldMustKeys = new Set(oldK.attributes.must.map(a => a.key));
    const newMustKeys = new Set(newK.attributes.must.map(a => a.key));
    for (const k of newMustKeys) { if (!oldMustKeys.has(k) && oldKeys.has(k)) changes.push(`^ ${kind}: ${k} upgraded to MUST`); }
    for (const k of oldMustKeys) { if (!newMustKeys.has(k) && newKeys.has(k)) changes.push(`v ${kind}: ${k} downgraded from MUST`); }
  }

  // Compare operation mapping
  for (const op of new Set([...Object.keys(oldRules.operationKindMapping || {}), ...Object.keys(newRules.operationKindMapping || {})])) {
    const oldV = oldRules.operationKindMapping?.[op];
    const newV = newRules.operationKindMapping?.[op];
    if (!oldV && newV) changes.push(`+ mapping: ${op} -> ${newV}`);
    else if (oldV && !newV) changes.push(`- mapping: ${op} -> ${oldV}`);
    else if (oldV !== newV) changes.push(`~ mapping: ${op}: ${oldV} -> ${newV}`);
  }

  return changes;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const specContent = await fetchSpec();
  console.log(`${TAG} spec loaded (${specContent.length} chars)`);

  const sections = parseSpec(specContent);
  const parsedKinds = Object.keys(sections).filter(k => k !== 'COMMON');
  console.log(`${TAG} parsed sections: COMMON, ${parsedKinds.join(', ')}`);
  for (const [kind, data] of Object.entries(sections)) {
    console.log(`${TAG}   ${kind}: ${data.attrs.length} attributes, ${data.resources.length} resources`);
  }

  const operationKindMapping = parseOperationKindMapping(specContent);
  console.log(`${TAG} operation-kind mappings: ${Object.keys(operationKindMapping).length}`);

  const newRules = buildRulesJson(sections, operationKindMapping);

  // Diff against existing
  const outputPath = opts.output;
  if (existsSync(outputPath)) {
    const oldRules = JSON.parse(readFileSync(outputPath, 'utf8'));
    const changes = diffRules(oldRules, newRules);
    if (changes.length === 0) {
      console.log(`${TAG} no changes detected`);
    } else {
      console.log(`${TAG} ${changes.length} change(s) detected:`);
      for (const c of changes) console.log(`${TAG}   ${c}`);
    }
    if (opts.diff) {
      process.exit(0);
    }
  }

  writeFileSync(outputPath, JSON.stringify(newRules, null, 2) + '\n', 'utf8');
  console.log(`${TAG} rules written to ${outputPath}`);

  // Verify
  const verify = JSON.parse(readFileSync(outputPath, 'utf8'));
  const kindCount = Object.keys(verify.spanKinds).length;
  const totalAttrs = Object.values(verify.spanKinds).reduce((sum, k) => sum + k.attributes.must.length + k.attributes.should.length, 0);
  console.log(`${TAG} verification: ${kindCount} span kinds, ${totalAttrs} total attributes, ${Object.keys(verify.operationKindMapping).length} mappings`);
}

main().catch(e => { console.error(`${TAG} error: ${e.message}`); process.exit(1); });
