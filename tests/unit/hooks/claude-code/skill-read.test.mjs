// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code Skill telemetry:
 *   - model-triggered Skill reuses the real TOOL span;
 *   - /skill and runtime meta injection produce a load_skill extension span;
 *   - the original isMeta body is restored to the matching prompt's LLM input.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../../../../assets/hooks/claude-code/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');

const SKILL_NAME = 'e2e-build-push';
const BASE_DIR = `/abs/workdir/.claude/skills/${SKILL_NAME}`;
const ROOT_SKILL = `${BASE_DIR}/SKILL.md`;
const META_BODY = `Base directory for this skill: ${BASE_DIR}\n\n# Title\n\nskill body secret`;
const SYNTH_PREFIX = 'toolu_skillload_';

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

function userPrompt(promptId, text, timestamp) {
  return {
    type: 'user',
    promptId,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function slashPrompt(promptId, skillName, args, timestamp) {
  return userPrompt(
    promptId,
    `<command-message>${skillName}</command-message>\n` +
      `<command-name>/${skillName}</command-name>\n` +
      `<command-args>${args}</command-args>`,
    timestamp,
  );
}

function skillToolUse(id, skillName, timestamp, messageId = 'msg_skill') {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id: messageId,
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: skillName } }],
      usage: { input_tokens: 2, output_tokens: 3 },
      stop_reason: 'tool_use',
    },
  };
}

function toolResult(id, content, timestamp, promptId) {
  return {
    type: 'user',
    ...(promptId ? { promptId } : {}),
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  };
}

function skillMeta({
  sourceToolUseId = null,
  promptId,
  timestamp,
  uuid = 'meta-skill-stable-uuid',
  baseDir = BASE_DIR,
  content,
}) {
  return {
    type: 'user',
    isMeta: true,
    ...(sourceToolUseId ? { sourceToolUseID: sourceToolUseId } : {}),
    ...(promptId ? { promptId } : {}),
    uuid,
    timestamp,
    message: {
      role: 'user',
      content: content ?? [{
        type: 'text',
        text: `Base directory for this skill: ${baseDir}\n\n# Title\n\nskill body secret`,
      }],
    },
  };
}

function assistantToolUse(id, name, input, timestamp, messageId) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id: messageId,
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'tool_use',
    },
  };
}

function finalAnswer(messageId, text, timestamp) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      id: messageId,
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    },
  };
}

function writeTranscript(sessionId, records) {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function runHook(sessionId, transcriptPath) {
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify({
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      cwd: '/abs/workdir',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'claude-code');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf-8').split('\n'))
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function events(records, eventName, toolName) {
  return records.filter((record) =>
    record['event.name'] === eventName &&
    (!toolName || record['gen_ai.tool.name'] === toolName));
}

function outputToolCalls(records) {
  return records
    .filter((record) => record['event.name'] === 'llm.response')
    .flatMap((record) => record['gen_ai.output.messages'] || [])
    .flatMap((message) => message.parts || [])
    .filter((part) => part.type === 'tool_call');
}

function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

describe('transcript parser Skill context', () => {
  test('model Skill tool is correlated with its isMeta body and restored to the next LLM input', () => {
    const file = writeTranscript('implicit-parser', [
      userPrompt('p1', 'use the skill', '2026-07-29T01:00:00.000Z'),
      skillToolUse('toolu_skill', SKILL_NAME, '2026-07-29T01:00:01.000Z'),
      toolResult('toolu_skill', `Launching skill: ${SKILL_NAME}`, '2026-07-29T01:00:02.000Z'),
      skillMeta({
        sourceToolUseId: 'toolu_skill',
        timestamp: '2026-07-29T01:00:02.500Z',
      }),
      finalAnswer('msg_final', 'done', '2026-07-29T01:00:03.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    expect(turns).toHaveLength(1);
    expect(turns[0].skillLoads).toEqual([expect.objectContaining({
      promptId: 'p1',
      trigger: 'model_tool',
      sourceToolUseId: 'toolu_skill',
      name: SKILL_NAME,
      id: SKILL_NAME,
      rootPath: ROOT_SKILL,
      metaUuid: 'meta-skill-stable-uuid',
    })]);
    const secondInput = collectStrings(turns[0].llmCalls[1].input_messages).join('\n');
    expect(secondInput).toContain(`Launching skill: ${SKILL_NAME}`);
    expect(secondInput).toContain(META_BODY);
  });

  test('direct slash command without sourceToolUseID becomes slash_command and keeps full meta input', () => {
    const file = writeTranscript('slash-parser', [
      slashPrompt('p1', SKILL_NAME, 'run it', '2026-07-29T01:00:00.000Z'),
      skillMeta({ promptId: 'p1', timestamp: '2026-07-29T01:00:00.100Z' }),
      finalAnswer('msg_final', 'done', '2026-07-29T01:00:01.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    expect(turns[0].skillLoads).toEqual([expect.objectContaining({
      trigger: 'slash_command',
      sourceToolUseId: null,
      name: SKILL_NAME,
      rootPath: ROOT_SKILL,
    })]);
    expect(collectStrings(turns[0].llmCalls[0].input_messages)).toContain(META_BODY);
  });

  test('conversationHistory is isolated by promptId and non-Skill meta remains excluded', () => {
    const file = writeTranscript('prompt-isolation', [
      {
        ...userPrompt('clear-prompt', 'local caveat', '2026-07-29T01:00:00.000Z'),
        isMeta: true,
      },
      slashPrompt('clear-prompt', 'clear', '', '2026-07-29T01:00:00.100Z'),
      slashPrompt('skill-prompt', SKILL_NAME, 'run it', '2026-07-29T01:00:01.000Z'),
      skillMeta({ promptId: 'skill-prompt', timestamp: '2026-07-29T01:00:01.100Z' }),
      finalAnswer('msg_final', 'done', '2026-07-29T01:00:02.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    const input = collectStrings(
      turns.find((turn) => turn.promptId === 'skill-prompt').llmCalls[0].input_messages,
    ).join('\n');
    expect(input).toContain(`/${SKILL_NAME}`);
    expect(input).toContain(META_BODY);
    expect(input).not.toContain('/clear');
    expect(input).not.toContain('local caveat');
  });

  test('assistant records with no promptId stay in an independent fallback turn', () => {
    const file = writeTranscript('missing-prompt', [
      finalAnswer('msg_orphan', 'orphan answer', '2026-07-29T01:00:00.000Z'),
      userPrompt('p1', 'real prompt', '2026-07-29T01:00:01.000Z'),
      finalAnswer('msg_real', 'real answer', '2026-07-29T01:00:02.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    expect(turns).toHaveLength(2);
    const realTurn = turns.find((turn) => turn.promptId === 'p1');
    const fallbackTurn = turns.find((turn) => turn.promptId === null);
    expect(realTurn.llmCalls.map((call) => call.message_id)).toEqual(['msg_real']);
    expect(fallbackTurn.llmCalls.map((call) => call.message_id)).toEqual(['msg_orphan']);
    expect(collectStrings(realTurn.llmCalls[0].input_messages)).not.toContain('orphan answer');
  });

  test('Skill-shaped meta without tool or slash correlation uses runtime_meta fallback', () => {
    const file = writeTranscript('runtime-meta', [
      userPrompt('p1', 'hello', '2026-07-29T01:00:00.000Z'),
      skillMeta({ promptId: 'p1', timestamp: '2026-07-29T01:00:00.100Z' }),
      finalAnswer('msg_final', 'done', '2026-07-29T01:00:01.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    expect(turns[0].skillLoads[0]).toEqual(expect.objectContaining({
      trigger: 'runtime_meta',
      name: SKILL_NAME,
    }));
  });

  test('legacy Skill meta without a base-dir prefix is restored through sourceToolUseID', () => {
    const legacyBody = '# Legacy Skill\n\nComplete skill instructions';
    const file = writeTranscript('legacy-source-linked', [
      userPrompt('p1', 'use skill', '2026-07-29T01:00:00.000Z'),
      skillToolUse('toolu_skill', SKILL_NAME, '2026-07-29T01:00:01.000Z'),
      skillMeta({
        sourceToolUseId: 'toolu_skill',
        timestamp: '2026-07-29T01:00:02.000Z',
        content: legacyBody,
      }),
      finalAnswer('msg_final', 'done', '2026-07-29T01:00:03.000Z'),
    ]);

    const { turns } = parseClaudeTranscript(file);
    expect(turns[0].skillLoads).toEqual([expect.objectContaining({
      trigger: 'model_tool',
      sourceToolUseId: 'toolu_skill',
      name: SKILL_NAME,
      id: SKILL_NAME,
      rootPath: null,
      content: legacyBody,
    })]);
    expect(collectStrings(turns[0].llmCalls[1].input_messages)).toContain(legacyBody);
  });
});

describe('Claude Code Skill TOOL events', () => {
  test('implicit Skill enriches the real TOOL and does not synthesize Read or load_skill', () => {
    const transcript = writeTranscript('implicit-hook', [
      userPrompt('p1', 'use the skill', '2026-07-29T02:00:00.000Z'),
      skillToolUse('toolu_skill', SKILL_NAME, '2026-07-29T02:00:01.000Z'),
      toolResult('toolu_skill', `Launching skill: ${SKILL_NAME}`, '2026-07-29T02:00:02.000Z'),
      skillMeta({
        sourceToolUseId: 'toolu_skill',
        timestamp: '2026-07-29T02:00:02.100Z',
      }),
      finalAnswer('msg_final', 'done', '2026-07-29T02:00:03.000Z'),
    ]);

    expect(runHook('implicit-hook', transcript).status).toBe(0);
    const records = readJsonlRecords();
    const calls = events(records, 'tool.call', 'Skill');
    const results = events(records, 'tool.result', 'Skill');
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({
      'gen_ai.tool.call.id': 'toolu_skill',
      'gen_ai.skill.name': SKILL_NAME,
      'gen_ai.skill.id': SKILL_NAME,
    }));
    expect(results[0]).toEqual(expect.objectContaining({
      'gen_ai.skill.name': SKILL_NAME,
      'gen_ai.skill.id': SKILL_NAME,
    }));
    expect(events(records, 'tool.call', 'load_skill')).toHaveLength(0);
    expect(events(records, 'tool.call', 'Read')).toHaveLength(0);
    expect(collectStrings(events(records, 'llm.request')[1])).toContain(META_BODY);
  });

  test('direct slash creates one deterministic load_skill extension TOOL without fake LLM output', () => {
    const sourceRecords = [
      slashPrompt('p1', SKILL_NAME, 'run it', '2026-07-29T02:00:00.000Z'),
      skillMeta({ promptId: 'p1', timestamp: '2026-07-29T02:00:00.100Z' }),
      assistantToolUse(
        'toolu_reference',
        'Read',
        { file_path: `${BASE_DIR}/references/guide.md` },
        '2026-07-29T02:00:01.000Z',
        'msg_read',
      ),
      toolResult('toolu_reference', 'reference body', '2026-07-29T02:00:01.100Z', 'p1'),
      finalAnswer('msg_final', 'done', '2026-07-29T02:00:02.000Z'),
    ];

    const idFromFreshRun = () => {
      const previousDataDir = DATA_DIR;
      DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skill-id-'));
      try {
        const transcript = writeTranscript('slash-hook', sourceRecords);
        expect(runHook('slash-hook', transcript).status).toBe(0);
        const records = readJsonlRecords();
        const loadCalls = events(records, 'tool.call', 'load_skill');
        const loadResults = events(records, 'tool.result', 'load_skill');
        expect(loadCalls).toHaveLength(1);
        expect(loadResults).toHaveLength(1);
        expect(loadCalls[0]).toEqual(expect.objectContaining({
          'gen_ai.tool.type': 'extension',
          'gen_ai.skill.name': SKILL_NAME,
          'gen_ai.skill.id': SKILL_NAME,
          'gen_ai.tool.call.arguments': { skill: SKILL_NAME },
        }));
        expect(loadResults[0]['gen_ai.tool.call.id']).toBe(loadCalls[0]['gen_ai.tool.call.id']);
        expect(BigInt(loadResults[0].time_unix_nano)).toBeGreaterThan(BigInt(loadCalls[0].time_unix_nano));
        expect(events(records, 'tool.call', 'Read').map((record) =>
          record['gen_ai.tool.call.id'])).toEqual(['toolu_reference']);
        expect(outputToolCalls(records).some((part) =>
          part.name === 'load_skill' || part.id?.startsWith(SYNTH_PREFIX))).toBe(false);
        return loadCalls[0]['gen_ai.tool.call.id'];
      } finally {
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
        DATA_DIR = previousDataDir;
      }
    };

    const id1 = idFromFreshRun();
    const id2 = idFromFreshRun();
    expect(id1).toMatch(/^toolu_skillload_[0-9a-f]{24}$/);
    expect(id2).toBe(id1);
  });

  test('captureMessageContent=false strips Skill body and tool payload but preserves Skill attributes', () => {
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
      agents: { 'claude-code': { enabled: true, captureMessageContent: false } },
    }));
    const transcript = writeTranscript('private-skill', [
      slashPrompt('p1', SKILL_NAME, 'run it', '2026-07-29T02:00:00.000Z'),
      skillMeta({ promptId: 'p1', timestamp: '2026-07-29T02:00:00.100Z' }),
      finalAnswer('msg_final', 'done', '2026-07-29T02:00:01.000Z'),
    ]);

    expect(runHook('private-skill', transcript).status).toBe(0);
    const records = readJsonlRecords();
    const call = events(records, 'tool.call', 'load_skill')[0];
    const result = events(records, 'tool.result', 'load_skill')[0];
    expect(call['gen_ai.skill.name']).toBe(SKILL_NAME);
    expect(call['gen_ai.skill.id']).toBe(SKILL_NAME);
    expect(call).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(result).not.toHaveProperty('gen_ai.tool.call.result');
    expect(JSON.stringify(records)).not.toContain('skill body secret');
  });

  test('ordinary Read tools are unchanged and never produce Skill load events', () => {
    const transcript = writeTranscript('ordinary-read', [
      userPrompt('p1', 'read it twice', '2026-07-29T02:00:00.000Z'),
      assistantToolUse('read-a', 'Read', { file_path: '/tmp/a' }, '2026-07-29T02:00:01.000Z', 'msg_a'),
      toolResult('read-a', 'a', '2026-07-29T02:00:01.100Z', 'p1'),
      assistantToolUse('read-b', 'Read', { file_path: '/tmp/a' }, '2026-07-29T02:00:02.000Z', 'msg_b'),
      toolResult('read-b', 'a', '2026-07-29T02:00:02.100Z', 'p1'),
      finalAnswer('msg_final', 'done', '2026-07-29T02:00:03.000Z'),
    ]);

    expect(runHook('ordinary-read', transcript).status).toBe(0);
    const records = readJsonlRecords();
    expect(events(records, 'tool.call', 'Read').map((record) =>
      record['gen_ai.tool.call.id'])).toEqual(['read-a', 'read-b']);
    expect(events(records, 'tool.call', 'load_skill')).toHaveLength(0);
    expect(events(records, 'tool.call', 'Skill')).toHaveLength(0);
  });
});
