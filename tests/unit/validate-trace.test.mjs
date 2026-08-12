import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
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
