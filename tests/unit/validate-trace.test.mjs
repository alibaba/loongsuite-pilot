import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildTraces,
  validateStructure,
  validateSemantic,
  validateTime,
  hasModelToolSpanForOutput,
  isRuntimeSkillLoadSpan,
  unmatchedToolsForLlmOutput,
  validateMessageField,
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


const historicalRules = JSON.parse(readFileSync(new URL('../fixtures/qwenpaw/trace-validation-rules.json', import.meta.url)));
const spanId = value => value.toString(16).padStart(16, '0');
const input = [{ role: 'user', parts: [{ type: 'text', content: 'question' }] }];
const output = [{ role: 'assistant', parts: [{ type: 'text', content: 'answer' }], finish_reason: 'stop' }];

function sample(kind, value, parent, options = {}) {
  return {
    traceId: '1234567890abcdef1234567890abcdef', spanId: spanId(value),
    parentSpanId: parent ? spanId(parent) : undefined, name: kind,
    startTimeUnixNano: String((options.start ?? 1) * 1_000_000),
    endTimeUnixNano: String((options.end ?? 1000) * 1_000_000),
    status: { code: options.error ? 2 : 0 },
    attributes: {
      'gen_ai.span.kind': kind, 'gen_ai.session.id': 'session', 'gen_ai.user.id': 'user',
      'gen_ai.agent.name': 'agent',
      ...(kind === 'LLM' ? { 'gen_ai.input.messages': input, 'gen_ai.output.messages': output } : {}),
      ...options.attributes,
    },
  };
}
function trace(spans) { return buildTraces(spans)[0]; }
function errors(checks, id) { return checks.filter(check => check.status === 'error' && (!id || check.id === id)); }

describe('validator native agent lifecycle compatibility', () => {
  test('restores the exact historical rules, not a permissive replacement', () => {
    // Source: git show 73c13d44af385b711a56314f4ceaab35b56a3706:docs/trace-validation-rules.json
    const bytes = readFileSync(new URL('../fixtures/qwenpaw/trace-validation-rules.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('b136289d5b500b1180ed838a667d9a8bf0305e16b9b1d6a62b721387d9756ab2');
    expect(historicalRules.timeRules.find(rule => rule.id === 'time.parent_contains_children').toleranceMs).toBe(0);
  });

  test('accepts multiple direct Agents and helpers under TOOL or AGENT', () => {
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1), sample('STEP', 3, 2), sample('LLM', 4, 3),
      sample('TOOL', 5, 3), sample('AGENT', 6, 5), sample('STEP', 7, 6), sample('LLM', 8, 7),
      sample('AGENT', 9, 1), sample('STEP', 10, 9), sample('LLM', 11, 10),
      sample('AGENT', 12, 2), sample('STEP', 13, 12), sample('LLM', 14, 13)];
    expect(errors(validateStructure(trace(spans)))).toEqual([]);
  });

  test('still rejects missing parents, parent cycles, duplicate IDs and disallowed Agent parents', () => {
    expect(errors(validateStructure(trace([sample('ENTRY', 1), sample('AGENT', 2, 99)])))).not.toEqual([]);
    const cyclic = validateStructure(trace([sample('ENTRY', 1), sample('AGENT', 2, 3), sample('AGENT', 3, 2)]));
    expect(errors(cyclic, 'structure.no_cycles')).toHaveLength(2);
    expect(errors(cyclic, 'structure.no_orphan_spans')).toHaveLength(1);
    const duplicated = validateStructure(trace([sample('ENTRY', 1), sample('AGENT', 2, 1), sample('AGENT', 2, 1)]));
    expect(errors(duplicated, 'structure.unique_span_ids')).toHaveLength(1);
    const wrongParent = validateStructure(trace([sample('ENTRY', 1), sample('AGENT', 2, 1), sample('STEP', 3, 2), sample('LLM', 4, 3), sample('AGENT', 5, 4)]));
    expect(errors(wrongParent, 'structure.agent_under_entry')).toHaveLength(1);
  });

  test('requires distinct explicit native attempts for a QwenPaw STEP with multiple LLMs', () => {
    const explicit = (value, parent, attempt) => ({ 'gen_ai.agent.type': 'qwenpaw',
      'gen_ai.step.id': attempt });
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1),
      sample('STEP', 3, 2, { attributes: explicit(3, 2) }),
      sample('LLM', 4, 3, { error: true, attributes: { ...explicit(4, 3, 'attempt-1'), 'gen_ai.output.messages': undefined } }),
      sample('LLM', 5, 3, { attributes: explicit(5, 3, 'attempt-2') })];
    expect(errors(validateStructure(trace(spans)), 'structure.step_has_one_llm')).toEqual([]);
    spans[4].attributes['gen_ai.step.id'] = 'attempt-1';
    expect(errors(validateStructure(trace(spans)), 'structure.step_has_one_llm')).toHaveLength(1);
    spans[4].attributes['gen_ai.step.id'] = 'attempt-2';
    delete spans[2].attributes['gen_ai.agent.type'];
    expect(errors(validateStructure(trace(spans)), 'structure.step_has_one_llm')).toHaveLength(1);
  });

  test('sums tokens per nearest owning Agent and detects cross-Agent double counting', () => {
    const usage = tokens => ({ 'gen_ai.usage.input_tokens': tokens });
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1, { attributes: usage(5) }), sample('STEP', 3, 2),
      sample('LLM', 4, 3, { attributes: usage(5) }), sample('TOOL', 5, 3),
      sample('AGENT', 6, 5, { attributes: usage(7) }), sample('STEP', 7, 6), sample('LLM', 8, 7, { attributes: usage(7) }),
      sample('AGENT', 9, 1, { attributes: usage(9) }), sample('STEP', 10, 9), sample('LLM', 11, 10, { attributes: usage(9) })];
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.agent_token_sum')).toEqual([]);
    spans[1].attributes['gen_ai.usage.input_tokens'] = 12;
    spans[5].attributes['gen_ai.usage.input_tokens'] = 21;
    const findings = errors(validateSemantic(trace(spans), historicalRules), 'semantic.agent_token_sum');
    expect(findings.map(finding => finding.spanId)).toEqual([spanId(2), spanId(6)]);
  });

  test('allows parallel steps across Agents but still rejects same-Agent overlap and child overrun', () => {
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1), sample('STEP', 3, 2, { attributes: { 'gen_ai.react.round': 1 } }),
      sample('AGENT', 4, 1), sample('STEP', 5, 4, { attributes: { 'gen_ai.react.round': 1 } })];
    expect(errors(validateTime(trace(spans), historicalRules))).toEqual([]);
    expect(validateTime(trace(spans), historicalRules).filter(check => check.id === 'time.chronological_steps' && check.status === 'warn')).toEqual([]);
    spans.push(sample('STEP', 6, 2), sample('TOOL', 7, 6, { end: 1001 }));
    const findings = validateTime(trace(spans), historicalRules);
    expect(errors(findings, 'time.no_step_overlap')).toHaveLength(1);
    expect(errors(findings, 'time.parent_contains_children')).toHaveLength(1);
  });

  test('permits absent provider-error output but still requires its input', () => {
    const spans = [sample('ENTRY', 1, undefined, { attributes: { 'gen_ai.input.messages': input } }), sample('AGENT', 2, 1),
      sample('STEP', 3, 2), sample('LLM', 4, 3, { error: true, attributes: { 'error.type': 'NotFoundError', 'gen_ai.output.messages': undefined } })];
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.llm_has_input_output')).toEqual([]);
    spans[3].attributes['gen_ai.input.messages'] = [];
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.llm_has_input_output')).toHaveLength(1);
  });

  test.each([undefined, [], '[]', null])('successful LLM missing/empty output remains an error (%j)', badOutput => {
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1), sample('STEP', 3, 2),
      sample('LLM', 4, 3, { attributes: { 'error.type': 'NotFoundError', 'gen_ai.output.messages': badOutput } })];
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.llm_has_input_output')).toHaveLength(1);
  });

  test('matches tools against successful retry output rather than only the first failed attempt', () => {
    const toolOutput = [{ role: 'assistant', finish_reason: 'tool_calls', parts: [{ type: 'tool_call', id: 'call', name: 'search' }] }];
    const spans = [sample('ENTRY', 1), sample('AGENT', 2, 1), sample('STEP', 3, 2),
      sample('LLM', 4, 3, { error: true, attributes: { 'gen_ai.output.messages': undefined } }),
      sample('LLM', 5, 3, { attributes: { 'gen_ai.output.messages': toolOutput } }),
      sample('TOOL', 6, 3, { attributes: { 'gen_ai.tool.call.id': 'call', 'gen_ai.tool.name': 'search' } })];
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.tool_matches_llm_output')).toEqual([]);
    spans[5].attributes['gen_ai.tool.call.id'] = 'wrong'; spans[5].attributes['gen_ai.tool.name'] = 'wrong';
    expect(errors(validateSemantic(trace(spans), historicalRules), 'semantic.tool_matches_llm_output').length).toBeGreaterThan(0);
  });
});
