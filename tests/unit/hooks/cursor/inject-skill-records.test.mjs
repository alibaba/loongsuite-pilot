import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { injectSkillRecords } from '../../../../assets/hooks/cursor-hook-processor.mjs';

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
    expect(toolCall['agent.cursor.skill_detection_source']).toBe('transcript_post_assembly');

    expect(toolResult['event.name']).toBe('tool.result');
    expect(toolResult['gen_ai.tool.name']).toBe('Read');
    expect(toolResult['gen_ai.skill.name']).toBe('my-skill');
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
    const records = [makeLlmResponse()];
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
    expect(JSON.stringify(records)).not.toContain(skillPath);
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
