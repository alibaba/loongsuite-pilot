import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import {
  filterSkillsForReadInjection,
  injectSkillRecords,
} from '../../../../assets/hooks/cursor-hook-processor.mjs';

const PROCESSOR_URL = new URL('../../../../assets/hooks/cursor-hook-processor.mjs', import.meta.url);

/**
 * Helper: create a minimal llm.response record.
 */
function makeLlmResponse(overrides = {}) {
  return {
    trace_id: 'trace-001',
    'gen_ai.session.id': 'session-001',
    'gen_ai.turn.id': 'turn-001',
    'gen_ai.step.id': 'step_1',
    'gen_ai.agent.type': 'cursor',
    'user.id': 'user-001',
    'event.id': 'evt-resp-001',
    'event.name': 'llm.response',
    time_unix_nano: '1700000000000000000',
    observed_time_unix_nano: '1700000000000000100',
    'gen_ai.output.messages': [
      { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
    ],
    ...overrides,
  };
}

/**
 * Helper: create a minimal llm.request record.
 */
function makeLlmRequest(overrides = {}) {
  return {
    trace_id: 'trace-001',
    'event.id': 'evt-req-001',
    'event.name': 'llm.request',
    time_unix_nano: '1700000000000000000',
    ...overrides,
  };
}

function makeSkill(name = 'my-skill', skillPath = '/Users/test/.cursor/skills/my-skill/SKILL.md') {
  return { skillName: name, skillPath };
}

describe('filterSkillsForReadInjection', () => {
  const skillWithSources = (...detectionSources) => ({
    ...makeSkill(),
    detectionSources,
  });

  it('should synthesize pure manual attachments after transcript assembly', () => {
    const skills = [skillWithSources('manual_attachment')];

    expect(filterSkillsForReadInjection(skills, true)).toEqual(skills);
  });

  it('should synthesize standalone agent_skill usage after transcript assembly', () => {
    const skills = [skillWithSources('agent_skill')];

    expect(filterSkillsForReadInjection(skills, true)).toEqual(skills);
  });

  it('should not synthesize transcript reads after transcript assembly', () => {
    const transcriptOnly = skillWithSources('transcript_read');
    const dualSource = skillWithSources('manual_attachment', 'transcript_read');

    expect(filterSkillsForReadInjection([transcriptOnly, dualSource], true)).toEqual([]);
  });

  it('should synthesize manual attachments and transcript reads on hook-event assembly paths', () => {
    const manualOnly = skillWithSources('manual_attachment');
    const transcriptOnly = skillWithSources('transcript_read');
    const dualSource = skillWithSources('manual_attachment', 'transcript_read');
    const skills = [manualOnly, transcriptOnly, dualSource];

    expect(filterSkillsForReadInjection(skills, false)).toEqual(skills);
  });
});

describe('injectSkillRecords', () => {
  it('should inject tool_call part into llm.response output.messages', () => {
    const records = [makeLlmResponse()];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    const llm = records[0];
    const assistantMsg = llm['gen_ai.output.messages'].find(m => m.role === 'assistant');
    const toolCallParts = assistantMsg.parts.filter(p => p.type === 'tool_call');
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]).toMatchObject({
      type: 'tool_call',
      name: 'Read',
      arguments: { path: '/Users/test/.cursor/skills/my-skill/SKILL.md' },
    });
    expect(toolCallParts[0].id).toBeDefined();
  });

  it('should insert tool.call and tool.result records after llm.response', () => {
    const records = [makeLlmResponse()];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    expect(records).toHaveLength(3);
    const toolCall = records[1];
    const toolResult = records[2];

    expect(toolCall['event.name']).toBe('tool.call');
    expect(toolCall['gen_ai.tool.name']).toBe('Read');
    expect(toolCall['gen_ai.tool.call.arguments']).toEqual({ path: '/Users/test/.cursor/skills/my-skill/SKILL.md' });
    expect(toolCall['gen_ai.skill.name']).toBe('my-skill');
    expect(toolCall['gen_ai.skill.id']).toBe('my-skill');
    expect(toolCall['agent.cursor.skill_detection_source']).toBe('transcript_post_assembly');

    expect(toolResult['event.name']).toBe('tool.result');
    expect(toolResult['gen_ai.tool.name']).toBe('Read');
    expect(toolResult['gen_ai.skill.name']).toBe('my-skill');
    expect(toolResult['gen_ai.skill.id']).toBe('my-skill');
    expect(toolResult['agent.cursor.skill_detection_source']).toBe('transcript_post_assembly');
  });

  it('should share the same toolCallId across output.messages, tool.call, and tool.result', () => {
    const records = [makeLlmResponse()];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    const llm = records[0];
    const assistantMsg = llm['gen_ai.output.messages'].find(m => m.role === 'assistant');
    const toolCallPart = assistantMsg.parts.find(p => p.type === 'tool_call');
    const toolCallRecord = records[1];
    const toolResultRecord = records[2];

    expect(toolCallPart.id).toBe(toolCallRecord['gen_ai.tool.call.id']);
    expect(toolCallRecord['gen_ai.tool.call.id']).toBe(toolResultRecord['gen_ai.tool.call.id']);
  });

  it('should backfill the synthetic skill exchange into subsequent LLM inputs', () => {
    const sourceCall = {
      type: 'tool_call',
      id: 'existing-call',
      name: 'Grep',
      arguments: { pattern: 'needle' },
    };
    const sourceResponse = {
      type: 'tool_call_response',
      id: 'existing-call',
      response: 'matched',
    };
    const firstResponse = makeLlmResponse({
      'gen_ai.output.messages': [{ role: 'assistant', parts: [sourceCall] }],
    });
    const secondRequest = makeLlmRequest({
      'event.id': 'evt-req-002',
      'gen_ai.turn.id': 'turn-001',
      'gen_ai.step.id': 'step_2',
      'gen_ai.input.messages_delta': [
        { role: 'assistant', parts: [sourceCall] },
        { role: 'tool', parts: [sourceResponse] },
      ],
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
        { role: 'assistant', parts: [sourceCall] },
        { role: 'tool', parts: [sourceResponse] },
      ],
    });
    const laterRequest = makeLlmRequest({
      'event.id': 'evt-req-003',
      'gen_ai.turn.id': 'turn-001',
      'gen_ai.step.id': 'step_3',
      'gen_ai.input.messages_delta': [
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'later-call', name: 'Shell' }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'later-call', response: 'ok' }] },
      ],
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
        { role: 'assistant', parts: [sourceCall] },
        { role: 'tool', parts: [sourceResponse] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'later-call', name: 'Shell' }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'later-call', response: 'ok' }] },
      ],
    });
    const records = [firstResponse, secondRequest, laterRequest];

    injectSkillRecords(records, [makeSkill()]);

    const skillCall = firstResponse['gen_ai.output.messages'][0].parts
      .find(part => part.type === 'tool_call' && part.name === 'Read');
    expect(skillCall).toBeDefined();

    const secondDelta = secondRequest['gen_ai.input.messages_delta'];
    expect(secondDelta.map(message => message.role))
      .toEqual(['assistant', 'tool', 'tool']);
    expect(secondDelta[0].parts.map(part => part.id))
      .toEqual(['existing-call', skillCall.id]);
    expect(secondDelta.slice(1).map(message => message.parts[0].id))
      .toEqual(['existing-call', skillCall.id]);
    expect(secondDelta[2].parts[0]).toMatchObject({
      type: 'tool_call_response',
      id: skillCall.id,
      response: '',
    });

    for (const request of [secondRequest, laterRequest]) {
      const fullMessages = request['gen_ai.input.messages'];
      const assistantParts = fullMessages
        .find(message => message.role === 'assistant' &&
          message.parts.some(part => part.id === 'existing-call')).parts;
      const toolParts = fullMessages
        .find(message => message.role === 'tool' &&
          message.parts.some(part => part.id === 'existing-call')).parts;
      expect(assistantParts.filter(part => part.id === skillCall.id)).toHaveLength(1);
      expect(toolParts.filter(part => part.id === skillCall.id)).toHaveLength(0);
      expect(fullMessages.find(message => message.role === 'tool' &&
        message.parts[0]?.id === skillCall.id)?.parts).toHaveLength(1);
    }

    // Only the immediate next request receives this exchange in its delta.
    expect(laterRequest['gen_ai.input.messages_delta'].flatMap(message => message.parts)
      .some(part => part.id === skillCall.id)).toBe(false);
  });

  it('should create assistant/tool history when the source response had no ordinary tools', () => {
    const firstResponse = makeLlmResponse();
    const secondRequest = makeLlmRequest({
      'event.id': 'evt-req-002',
      'gen_ai.turn.id': 'turn-001',
      'gen_ai.step.id': 'step_2',
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
      ],
    });
    const laterRequest = makeLlmRequest({
      'event.id': 'evt-req-003',
      'gen_ai.turn.id': 'turn-001',
      'gen_ai.step.id': 'step_3',
      'gen_ai.input.messages_delta': [
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'later-call', name: 'Shell' }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'later-call', response: 'ok' }] },
      ],
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'later-call', name: 'Shell' }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'later-call', response: 'ok' }] },
      ],
    });
    const records = [firstResponse, secondRequest, laterRequest];

    injectSkillRecords(records, [makeSkill()]);

    const skillCall = firstResponse['gen_ai.output.messages'][0].parts
      .find(part => part.type === 'tool_call' && part.name === 'Read');
    expect(secondRequest['gen_ai.input.messages_delta'].map(message => message.role))
      .toEqual(['assistant', 'tool']);
    expect(secondRequest['gen_ai.input.messages'].map(message => message.role))
      .toEqual(['user', 'assistant', 'tool']);
    expect(secondRequest['gen_ai.input.messages'][1].parts[0].id).toBe(skillCall.id);
    expect(secondRequest['gen_ai.input.messages'][2].parts[0].id).toBe(skillCall.id);
    expect(laterRequest['gen_ai.input.messages'].map(message => message.role))
      .toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(laterRequest['gen_ai.input.messages'][1].parts[0].id).toBe(skillCall.id);
    expect(laterRequest['gen_ai.input.messages'][3].parts[0].id).toBe('later-call');
  });

  it('should preserve the synthetic skill exchange in the converted next LLM span', async () => {
    const common = {
      trace_id: '0123456789abcdef0123456789abcdef',
      'gen_ai.session.id': 'session-conversion',
      'gen_ai.turn.id': 'turn-conversion',
      'gen_ai.agent.type': 'cursor',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'test-model',
      'user.id': 'user-conversion',
    };
    const sourceCall = {
      type: 'tool_call', id: 'existing-call', name: 'Grep', arguments: { pattern: 'x' },
    };
    const sourceResponse = {
      type: 'tool_call_response', id: 'existing-call', response: 'matched',
    };
    const reasoningPart = { type: 'reasoning', content: 'inspect first' };
    const firstResponse = {
      ...makeLlmResponse({
        ...common,
        'gen_ai.step.id': 'turn-conversion:s1',
        time_unix_nano: '2000000000',
        observed_time_unix_nano: '2000000000',
        'gen_ai.response.model': 'test-model',
        'gen_ai.response.finish_reasons': ['tool_calls'],
        'gen_ai.output.messages': [{
          role: 'assistant',
          parts: [reasoningPart, sourceCall],
          finish_reason: 'tool_calls',
        }],
      }),
    };
    const secondRequest = {
      ...makeLlmRequest({
        ...common,
        'event.id': 'evt-request-2',
        'gen_ai.step.id': 'turn-conversion:s2',
        time_unix_nano: '4000000000',
        observed_time_unix_nano: '4000000000',
        'gen_ai.input.messages_delta': [
          { role: 'assistant', parts: [reasoningPart, sourceCall] },
          { role: 'tool', parts: [sourceResponse] },
        ],
        'gen_ai.input.messages': [
          { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
          { role: 'assistant', parts: [reasoningPart, sourceCall] },
          { role: 'tool', parts: [sourceResponse] },
        ],
      }),
    };
    const records = [
      {
        ...common,
        'event.id': 'evt-request-1',
        'event.name': 'llm.request',
        'gen_ai.step.id': 'turn-conversion:s1',
        time_unix_nano: '1000000000',
        observed_time_unix_nano: '1000000000',
        'gen_ai.input.messages_delta': [
          { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
        ],
        'gen_ai.input.messages': [
          { role: 'user', parts: [{ type: 'text', content: 'prompt' }] },
        ],
      },
      {
        ...common,
        'event.id': 'evt-tool-call',
        'event.name': 'tool.call',
        'gen_ai.step.id': 'turn-conversion:s1',
        'gen_ai.tool.name': 'Grep',
        'gen_ai.tool.call.id': 'existing-call',
        time_unix_nano: '2000000000',
        observed_time_unix_nano: '2000000000',
      },
      {
        ...common,
        'event.id': 'evt-tool-result',
        'event.name': 'tool.result',
        'gen_ai.step.id': 'turn-conversion:s1',
        'gen_ai.tool.name': 'Grep',
        'gen_ai.tool.call.id': 'existing-call',
        time_unix_nano: '3000000000',
        observed_time_unix_nano: '3000000000',
      },
      firstResponse,
      secondRequest,
      {
        ...common,
        'event.id': 'evt-response-2',
        'event.name': 'llm.response',
        'gen_ai.step.id': 'turn-conversion:s2',
        'gen_ai.response.model': 'test-model',
        'gen_ai.response.finish_reasons': ['stop'],
        time_unix_nano: '5000000000',
        observed_time_unix_nano: '5000000000',
        'gen_ai.output.messages': [{
          role: 'assistant',
          parts: [{ type: 'text', content: 'done' }],
          finish_reason: 'stop',
        }],
      },
    ];

    injectSkillRecords(records, [makeSkill()]);
    const skillCallId = firstResponse['gen_ai.output.messages'][0].parts
      .find(part => part.type === 'tool_call' && part.name === 'Read').id;

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(records);
      expect(conversion.warnings).toEqual([]);
      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llmSpans).toHaveLength(2);
      const secondInput = JSON.parse(String(
        llmSpans[1].attributes['gen_ai.input.messages'],
      ));
      expect(secondInput.map(message => message.role))
        .toEqual(['user', 'assistant', 'tool', 'tool']);
      expect(secondInput[1].parts.map(part => part.type))
        .toEqual(['reasoning', 'tool_call', 'tool_call']);
      const skillParts = secondInput
        .flatMap(message => message.parts)
        .filter(part => part.id === skillCallId);
      expect(skillParts.map(part => part.type)).toEqual([
        'tool_call',
        'tool_call_response',
      ]);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

  it('should assign strictly increasing timestamps relative to llm.response', () => {
    const baseTime = '1700000000000000000';
    const records = [makeLlmResponse({ time_unix_nano: baseTime })];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    const toolCall = records[1];
    const toolResult = records[2];

    expect(toolCall.time_unix_nano).toBe(String(BigInt(baseTime) + 1n));
    expect(toolResult.time_unix_nano).toBe(String(BigInt(baseTime) + 2n));
    expect(BigInt(toolCall.time_unix_nano)).toBeGreaterThan(BigInt(baseTime));
    expect(BigInt(toolResult.time_unix_nano)).toBeGreaterThan(BigInt(toolCall.time_unix_nano));
  });

  it('should handle multiple skills with correct timestamps and paired IDs', () => {
    const records = [makeLlmResponse()];
    const skills = [makeSkill('skill-a', '/path/a/SKILL.md'), makeSkill('skill-b', '/path/b/SKILL.md')];

    injectSkillRecords(records, skills);

    // 1 original + 4 inserted = 5
    expect(records).toHaveLength(5);

    const baseTime = BigInt('1700000000000000000');
    const call1 = records[1];
    const result1 = records[2];
    const call2 = records[3];
    const result2 = records[4];

    // Verify timestamps: +1, +2, +3, +4
    expect(call1.time_unix_nano).toBe(String(baseTime + 1n));
    expect(result1.time_unix_nano).toBe(String(baseTime + 2n));
    expect(call2.time_unix_nano).toBe(String(baseTime + 3n));
    expect(result2.time_unix_nano).toBe(String(baseTime + 4n));

    // Verify paired IDs
    expect(call1['gen_ai.tool.call.id']).toBe(result1['gen_ai.tool.call.id']);
    expect(call2['gen_ai.tool.call.id']).toBe(result2['gen_ai.tool.call.id']);
    expect(call1['gen_ai.tool.call.id']).not.toBe(call2['gen_ai.tool.call.id']);

    // Verify skill names
    expect(call1['gen_ai.skill.name']).toBe('skill-a');
    expect(call2['gen_ai.skill.name']).toBe('skill-b');
  });

  it('should not modify records when no llm.response exists', () => {
    const records = [makeLlmRequest()];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    expect(records).toHaveLength(1);
    expect(records[0]['event.name']).toBe('llm.request');
  });

  it('should handle empty records array without error', () => {
    const records = [];
    const skills = [makeSkill()];

    expect(() => injectSkillRecords(records, skills)).not.toThrow();
    expect(records).toHaveLength(0);
  });

  it('should not modify records when the skill list is empty', () => {
    const records = [makeLlmResponse()];
    const before = JSON.parse(JSON.stringify(records));

    injectSkillRecords(records, []);

    expect(records).toEqual(before);
  });

  it('should append tool_call parts without overwriting existing output.messages', () => {
    const existingParts = [
      { type: 'text', text: 'existing response' },
      { type: 'tool_call', id: 'existing-id', name: 'Write', arguments: { path: '/tmp/x' } },
    ];
    const records = [
      makeLlmResponse({
        'gen_ai.output.messages': [
          { role: 'assistant', parts: [...existingParts] },
        ],
      }),
    ];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    const llm = records[0];
    const assistantMsg = llm['gen_ai.output.messages'].find(m => m.role === 'assistant');
    // Original parts are preserved
    expect(assistantMsg.parts[0]).toEqual(existingParts[0]);
    expect(assistantMsg.parts[1]).toEqual(existingParts[1]);
    // New tool_call appended at end
    expect(assistantMsg.parts).toHaveLength(3);
    expect(assistantMsg.parts[2].type).toBe('tool_call');
    expect(assistantMsg.parts[2].name).toBe('Read');
  });

  it('should use time_unix_nano for observed_time_unix_nano fallback when missing', () => {
    const baseTime = '1700000000000000000';
    const records = [
      makeLlmResponse({
        time_unix_nano: baseTime,
        observed_time_unix_nano: undefined,
      }),
    ];
    const skills = [makeSkill()];

    injectSkillRecords(records, skills);

    const toolCall = records[1];
    const toolResult = records[2];

    // When observed_time_unix_nano is missing, fallback to time_unix_nano
    expect(toolCall.observed_time_unix_nano).toBe(String(BigInt(baseTime) + 1n));
    expect(toolResult.observed_time_unix_nano).toBe(String(BigInt(baseTime) + 2n));
  });

  it('should apply captureMessageContent=false to injected response and tool records', () => {
    const skillPath = '/Users/alice/.cursor/skills/private-skill/SKILL.md';
    const records = [
      makeLlmResponse(),
      makeLlmRequest({
        'event.id': 'evt-req-002',
        'gen_ai.turn.id': 'turn-001',
        'gen_ai.step.id': 'step_2',
        'gen_ai.agent.type': 'cursor',
        'gen_ai.input.messages': [
          { role: 'user', parts: [{ type: 'text', content: 'private prompt' }] },
        ],
      }),
    ];
    const runtimeConfig = {
      agents: {
        cursor: { captureMessageContent: false },
      },
    };

    injectSkillRecords(
      records,
      [makeSkill('private-skill', skillPath)],
      runtimeConfig,
    );

    expect(records[0]['gen_ai.output.messages']).toBeUndefined();
    expect(records[1]['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(records[1]['gen_ai.skill.name']).toBe('private-skill');
    expect(records[2]['gen_ai.skill.name']).toBe('private-skill');
    expect(records[3]['gen_ai.input.messages_delta']).toBeUndefined();
    expect(records[3]['gen_ai.input.messages']).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain(skillPath);
    expect(JSON.stringify(records)).not.toContain('private prompt');
  });

  it('should synthesize Read records for a manually attached skill path', () => {
    const records = [makeLlmResponse()];
    const skills = [{
      ...makeSkill(
        'count-if-statements',
        '/Users/test/.cursor/skills/count-if-statements/SKILL.md',
      ),
      detectionSource: 'manual_attachment',
      detectionSources: ['manual_attachment'],
    }];

    injectSkillRecords(records, skills);

    const assistantMsg = records[0]['gen_ai.output.messages']
      .find(message => message.role === 'assistant');
    expect(assistantMsg.parts).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'Read',
      arguments: {
        path: '/Users/test/.cursor/skills/count-if-statements/SKILL.md',
      },
    }));
    expect(records[1]).toMatchObject({
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.arguments': {
        path: '/Users/test/.cursor/skills/count-if-statements/SKILL.md',
      },
      'gen_ai.skill.name': 'count-if-statements',
      'gen_ai.skill.id': 'count-if-statements',
      'agent.cursor.skill_detection_source': 'manual_attachment',
    });
    expect(records[2]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'Read',
      'gen_ai.skill.name': 'count-if-statements',
      'gen_ai.skill.id': 'count-if-statements',
      'agent.cursor.skill_detection_source': 'manual_attachment',
    });
  });

  it('should not execute main when imported', () => {
    const imported = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(PROCESSOR_URL.href)})`,
      ],
      { encoding: 'utf-8' },
    );

    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
  });

  it('should still execute main when invoked directly', () => {
    const invoked = spawnSync(
      process.execPath,
      [fileURLToPath(PROCESSOR_URL)],
      { input: '', encoding: 'utf-8' },
    );

    expect(invoked.status).toBe(0);
    expect(invoked.stdout).toBe('{}\n');
  });
});
