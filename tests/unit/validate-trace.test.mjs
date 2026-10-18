import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTraces,
  hasModelToolSpanForOutput,
  isRuntimeSkillLoadSpan,
  unmatchedToolsForLlmOutput,
  validateMessageField,
  validateSemantic,
  validateStructure,
  validateTime,
} from '../../scripts/validate-trace.mjs';

const LOONGSUITE_INPUT_MESSAGES_SCHEMA_SOURCE =
  'https://github.com/alibaba/loongsuite-semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-input-messages.json';
const LOONGSUITE_INPUT_MESSAGES_SCHEMA_SHA256 =
  'c1fddd81ea2b3cd547f74407f1267658f400f5c608772ab2fc4d9a5b3d16297f';

function tool(attributes) {
  return { spanId: attributes['gen_ai.tool.call.id'], attributes };
}

function validateInputMessages(messages) {
  const checks = [];
  validateMessageField(
    { 'gen_ai.input.messages': messages },
    'gen_ai.input.messages',
    'schema.input_messages',
    { spanId: 'llm-span', name: 'chat test-model' },
    checks,
  );
  return checks;
}

describe('semantic.tool_matches_llm_output runtime Skill handling', () => {
  test('extension TOOL with Skill attributes does not require an LLM output tool_call', () => {
    const runtimeSkill = tool({
      'gen_ai.tool.name': 'load_skill',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': 'toolu_skillload_1',
      'gen_ai.skill.name': 'dws',
      'gen_ai.skill.id': 'dws',
    });

    expect(isRuntimeSkillLoadSpan(runtimeSkill)).toBe(true);
    expect(unmatchedToolsForLlmOutput([runtimeSkill], [])).toEqual([]);
    expect(hasModelToolSpanForOutput([runtimeSkill], {
      id: 'toolu_skillload_1',
      name: 'load_skill',
    })).toBe(false);
  });

  test('ordinary and model-triggered tools still require matching LLM output', () => {
    const ordinary = tool({
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': 'toolu_read_1',
    });
    const modelSkill = tool({
      'gen_ai.tool.name': 'Skill',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': 'toolu_skill_1',
      'gen_ai.skill.name': 'dws',
      'gen_ai.skill.id': 'dws',
    });

    expect(isRuntimeSkillLoadSpan(ordinary)).toBe(false);
    expect(isRuntimeSkillLoadSpan(modelSkill)).toBe(false);
    expect(unmatchedToolsForLlmOutput([ordinary, modelSkill], [])).toEqual([
      ordinary,
      modelSkill,
    ]);
    expect(unmatchedToolsForLlmOutput([ordinary, modelSkill], [
      { id: 'toolu_read_1', name: 'Read' },
      { id: 'toolu_skill_1', name: 'Skill' },
    ])).toEqual([]);
    expect(hasModelToolSpanForOutput([ordinary, modelSkill], {
      id: 'toolu_skill_1',
      name: 'Skill',
    })).toBe(true);
  });

  test('extension without Skill attributes is not exempted', () => {
    const extensionTool = tool({
      'gen_ai.tool.name': 'runtime_extension',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': 'runtime_1',
    });

    expect(isRuntimeSkillLoadSpan(extensionTool)).toBe(false);
    expect(unmatchedToolsForLlmOutput([extensionTool], [])).toEqual([extensionTool]);
  });
});

const traceRules = JSON.parse(readFileSync(new URL('../../docs/trace-validation-rules.json', import.meta.url), 'utf8'));

function delegatedTrace() {
  let nextId = 1;
  const spans = [];
  const answer = (content) => [{ role: 'assistant', finish_reason: 'stop', parts: [{ type: 'text', content }] }];
  function span(kind, parent, session, turn, start, end, attributes = {}) {
    const value = {
      traceId: 'a'.repeat(32), spanId: (nextId++).toString(16).padStart(16, '0'),
      parentSpanId: parent?.spanId,
      name: kind, startTimeUnixNano: String(start), endTimeUnixNano: String(end),
      attributes: {
        'gen_ai.span.kind': kind,
        'gen_ai.session.id': session, 'gen_ai.turn.id': turn,
        'gen_ai.agent.name': session,
        ...attributes,
      },
    };
    spans.push(value);
    return value;
  }
  const entry = span('ENTRY', null, 'parent', 'parent-turn', 1, 100, {
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'delegate' }] }],
    'gen_ai.output.messages': answer('parent result'),
  });
  const parent = span('AGENT', entry, 'parent', 'parent-turn', 1, 100, { 'gen_ai.usage.input_tokens': 3 });
  const first = span('STEP', parent, 'parent', 'parent-turn', 2, 20, { 'gen_ai.react.round': 1 });
  span('LLM', first, 'parent', 'parent-turn', 2, 10, {
    'gen_ai.input.messages': [], 'gen_ai.usage.input_tokens': 1,
    'gen_ai.output.messages': [{ role: 'assistant', finish_reason: 'tool_call', parts: [{ type: 'tool_call', name: 'spawn_agent', id: 'call-1' }] }],
  });
  const toolSpan = span('TOOL', first, 'parent', 'parent-turn', 10, 20, {
    'gen_ai.tool.name': 'spawn_agent', 'gen_ai.tool.call.id': 'call-1', 'gen_ai.tool.call.arguments': '{}',
  });
  const final = span('STEP', parent, 'parent', 'parent-turn', 30, 100, { 'gen_ai.react.round': 2 });
  const parentLlm = span('LLM', final, 'parent', 'parent-turn', 30, 100, {
    'gen_ai.input.messages': [], 'gen_ai.output.messages': answer('parent result'), 'gen_ai.usage.input_tokens': 2,
  });
  function child(session, turn, start, end, tokens = 10, parentTool = toolSpan) {
    const agent = span('AGENT', parentTool, session, turn, start, end, {
      'gen_ai.agent.parent.invocation.id': `invocation-${turn}`, 'gen_ai.usage.input_tokens': tokens,
    });
    const step = span('STEP', agent, session, turn, start, end, { 'gen_ai.react.round': 1 });
    const llm = span('LLM', step, session, turn, start, end, {
      'gen_ai.input.messages': [], 'gen_ai.output.messages': answer(`${session} result`), 'gen_ai.usage.input_tokens': tokens,
    });
    return { agent, step, llm };
  }
  const delegated = child('child', 'child-turn-1', 15, 150);
  child('child', 'child-turn-2', 25, 200, 20);
  return { spans, entry, parent, parentLlm, toolSpan, delegated, child, span };
}

function checkTrace(spans) {
  const [trace] = buildTraces(spans);
  return [...validateStructure(trace), ...validateTime(trace, traceRules), ...validateSemantic(trace, traceRules)];
}

describe('delegated trace validation scopes', () => {
  test('regenerating rules retains delegated topology, identity and execution scopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-trace-rules-'));
    const specPath = join(dir, 'spec.md');
    const outputPath = join(dir, 'rules.json');
    try {
      writeFileSync(specPath, '# Agent\n## Attributes\n');
      execFileSync(process.execPath, [
        fileURLToPath(new URL('../../scripts/update-validation-rules.mjs', import.meta.url)),
        '--spec-file', specPath, '--output', outputPath,
      ]);
      const generated = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(generated.version).toBe(traceRules.version);
      for (const kind of ['ENTRY', 'AGENT', 'TOOL']) {
        const { attributes: _generatedAttrs, ...generatedMeta } = generated.spanKinds[kind];
        const { attributes: _checkedInAttrs, ...checkedInMeta } = traceRules.spanKinds[kind];
        expect(generatedMeta).toEqual(checkedInMeta);
      }
      expect(generated.timeRules).toEqual(traceRules.timeRules);
      for (const rule of traceRules.semanticRules.filter(rule => rule.scope)) {
        expect(generated.semanticRules.find(candidate => candidate.id === rule.id)).toEqual(rule);
      }
    } finally {
      for (const file of [specPath, outputPath]) {
        try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      rmdirSync(dir);
    }
  });

  test('accepts independent child turns, overlapping execution and late child completion', () => {
    const fixture = delegatedTrace();
    const checks = checkTrace(fixture.spans);
    expect(checks.filter(c => c.status === 'error')).toEqual([]);
    expect(checks.filter(c => c.status === 'warn' && [
      'time.chronological_steps', 'semantic.entry_output_matches', 'semantic.consistent_agent_name',
    ].includes(c.id))).toEqual([]);
  });

  test('accepts nested delegation under the immediate child tool without aggregating descendant usage', () => {
    const fixture = delegatedTrace();
    const nestedTool = fixture.span('TOOL', fixture.delegated.step, 'child', 'child-turn-1', 20, 30, {
      'gen_ai.tool.name': 'spawn_agent', 'gen_ai.tool.call.id': 'nested', 'gen_ai.tool.call.arguments': '{}',
    });
    fixture.delegated.llm.endTimeUnixNano = '20';
    fixture.delegated.llm.attributes['gen_ai.output.messages'] = [{ role: 'assistant', finish_reason: 'tool_call', parts: [{ type: 'tool_call', name: 'spawn_agent', id: 'nested' }] }];
    fixture.delegated.step.endTimeUnixNano = '30';
    const finalStep = fixture.span('STEP', fixture.delegated.agent, 'child', 'child-turn-1', 40, 150, { 'gen_ai.react.round': 2 });
    fixture.span('LLM', finalStep, 'child', 'child-turn-1', 40, 150, {
      'gen_ai.input.messages': [], 'gen_ai.output.messages': [], 'gen_ai.usage.input_tokens': 0,
    });
    fixture.child('grandchild', 'grandchild-turn', 22, 250, 40, nestedTool);
    expect(checkTrace(fixture.spans).filter(c => c.status === 'error')).toEqual([]);
  });

  test('recognizes a delegated-only local fragment and reports its external parent boundary', () => {
    const fixture = delegatedTrace();
    const checks = checkTrace([fixture.delegated.agent, fixture.delegated.step, fixture.delegated.llm]);
    expect(checks.filter(c => c.status === 'error')).toEqual([]);
    expect(checks).toContainEqual(expect.objectContaining({ id: 'structure.external_parent_context', status: 'warn' }));
    delete fixture.delegated.agent.attributes['gen_ai.agent.parent.invocation.id'];
    expect(checkTrace([fixture.delegated.agent, fixture.delegated.step, fixture.delegated.llm]))
      .toContainEqual(expect.objectContaining({ id: 'structure.agent_under_entry', status: 'error' }));
  });

  test('rejects an all-zero external delegation parent span ID', () => {
    const fixture = delegatedTrace();
    fixture.delegated.agent.parentSpanId = '0000000000000000';
    const checks = checkTrace([fixture.delegated.agent, fixture.delegated.step, fixture.delegated.llm]);
    for (const id of ['structure.single_entry', 'structure.agent_under_entry']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'error' }));
    }
    expect(checks).not.toContainEqual(expect.objectContaining({ id: 'structure.external_parent_context' }));
  });

  test.each(['gen_ai.session.id', 'gen_ai.turn.id'])(
    'rejects %s corruption inside a child execution', (key) => {
      const fixture = delegatedTrace();
      fixture.delegated.llm.attributes[key] = 'wrong-identity';
      expect(checkTrace(fixture.spans)).toContainEqual(expect.objectContaining({
        id: key === 'gen_ai.session.id' ? 'semantic.consistent_session_id' : 'semantic.consistent_turn_id', status: 'error',
        spanId: fixture.delegated.agent.spanId,
      }));
    },
  );

  test('still rejects within-agent STEP overlap, incorrect tokens and a nonfinal tool response', () => {
    const fixture = delegatedTrace();
    fixture.parentLlm.attributes['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'tool_call', name: 'unexpected' }] }];
    fixture.delegated.agent.attributes['gen_ai.usage.input_tokens'] = 999;
    const overlappingStep = fixture.span('STEP', fixture.delegated.agent, 'child', 'child-turn-1', 20, 150, { 'gen_ai.react.round': 1 });
    fixture.span('LLM', overlappingStep, 'child', 'child-turn-1', 20, 150, { 'gen_ai.input.messages': [], 'gen_ai.output.messages': [] });
    const checks = checkTrace(fixture.spans);
    for (const id of ['time.no_step_overlap', 'semantic.agent_token_sum', 'semantic.last_step_no_tool_call']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'error' }));
    }
    expect(checks).toContainEqual(expect.objectContaining({ id: 'time.chronological_steps', status: 'warn' }));
  });

  test('keeps ordinary containment and rejects delegated work starting before its tool', () => {
    const fixture = delegatedTrace();
    fixture.delegated.llm.endTimeUnixNano = '151';
    fixture.delegated.agent.startTimeUnixNano = '5';
    const containment = checkTrace(fixture.spans).filter(c => c.id === 'time.parent_contains_children' && c.status === 'error');
    expect(containment.map(c => c.spanId)).toEqual(expect.arrayContaining([fixture.delegated.llm.spanId, fixture.delegated.agent.spanId]));
  });

  test('still rejects AGENT under STEP and duplicate root AGENTs', () => {
    const fixture = delegatedTrace();
    fixture.delegated.agent.parentSpanId = fixture.toolSpan.parentSpanId;
    fixture.span('AGENT', fixture.entry, 'parent', 'parent-turn', 1, 100);
    const checks = checkTrace(fixture.spans);
    for (const id of ['structure.agent_under_entry', 'structure.single_agent']) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status: 'error' }));
    }
  });
});

describe('gen_ai.input.messages schema validation', () => {
  test('vendored schema matches the pinned LoongSuite source', () => {
    const schema = readFileSync(new URL('../schemas/gen-ai-input-messages.json', import.meta.url));
    const actualSha256 = createHash('sha256').update(schema).digest('hex');

    expect({
      source: LOONGSUITE_INPUT_MESSAGES_SCHEMA_SOURCE,
      sha256: actualSha256,
    }).toEqual({
      source: LOONGSUITE_INPUT_MESSAGES_SCHEMA_SOURCE,
      sha256: LOONGSUITE_INPUT_MESSAGES_SCHEMA_SHA256,
    });
  });

  test('accepts all standard part types and optional nullable fields', () => {
    const checks = validateInputMessages([{
      role: 'user',
      name: null,
      parts: [
        { type: 'text', content: '' },
        { type: 'tool_call', name: 'Read' },
        { type: 'tool_call_response', response: null },
        {
          type: 'server_tool_call',
          name: 'web_search',
          server_tool_call: { type: 'web_search' },
        },
        {
          type: 'server_tool_call_response',
          server_tool_call_response: { type: 'web_search_result' },
        },
        { type: 'blob', modality: 'image', content: '' },
        { type: 'file', modality: 'document', file_id: 'file-1' },
        { type: 'uri', modality: 'image', uri: 'https://example.test/image.png' },
        { type: 'reasoning', content: '' },
      ],
    }]);

    expect(checks).toEqual([]);
  });

  test('rejects WorkBuddy tool result field in place of response', () => {
    const checks = validateInputMessages([{
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: 'call-1',
        result: { ok: true },
      }],
    }]);

    expect(checks).toEqual([
      expect.objectContaining({
        status: 'error',
        detail: expect.stringContaining('ToolCallResponsePart missing required "response"'),
      }),
    ]);
  });

  test.each(['image', 'compaction'])(
    'allows GenericPart extension %s with a compatibility warning',
    (partType) => {
      const checks = validateInputMessages([{
        role: 'user',
        parts: [{ type: partType }],
      }]);

      expect(checks).toEqual([
        expect.objectContaining({
          status: 'warn',
          detail: expect.stringContaining(`GenericPart extension type="${partType}"`),
        }),
      ]);
    },
  );

  test.each([
    ['message role', [{ role: 123, parts: [] }], 'missing required string "role"'],
    ['message parts', [{ role: 'user' }], 'missing required array "parts"'],
    ['part type', [{ role: 'user', parts: [{}] }], 'missing required string "type"'],
    ['text content', [{ role: 'user', parts: [{ type: 'text' }] }], 'TextPart missing required "content"'],
    ['tool call name', [{ role: 'assistant', parts: [{ type: 'tool_call' }] }], 'ToolCallRequestPart missing required "name"'],
    ['server tool call', [{ role: 'assistant', parts: [{ type: 'server_tool_call', name: 'web_search' }] }], 'ServerToolCallPart missing required "server_tool_call"'],
    ['server tool response', [{ role: 'assistant', parts: [{ type: 'server_tool_call_response' }] }], 'ServerToolCallResponsePart missing required "server_tool_call_response"'],
    ['blob modality', [{ role: 'user', parts: [{ type: 'blob', content: '' }] }], 'BlobPart missing required "modality"'],
    ['blob content', [{ role: 'user', parts: [{ type: 'blob', modality: 'image' }] }], 'BlobPart missing required "content"'],
    ['file id', [{ role: 'user', parts: [{ type: 'file', modality: 'document' }] }], 'FilePart missing required "file_id"'],
    ['URI', [{ role: 'user', parts: [{ type: 'uri', modality: 'image' }] }], 'UriPart missing required "uri"'],
    ['reasoning content', [{ role: 'assistant', parts: [{ type: 'reasoning' }] }], 'ReasoningPart missing required "content"'],
  ])('rejects missing required %s', (_label, messages, expectedDetail) => {
    const checks = validateInputMessages(messages);

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'error',
        detail: expect.stringContaining(expectedDetail),
      }),
    ]));
  });
});
