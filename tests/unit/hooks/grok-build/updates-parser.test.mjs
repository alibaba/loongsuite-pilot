import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGrokUpdates } from '../../../../assets/hooks/grok-build/updates-parser.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function withTempFile(records, suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-updates-parser-'));
  const file = path.join(dir, 'updates.jsonl');
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n' + suffix,
    'utf-8',
  );
  return { dir, file };
}

describe('parseGrokUpdates', () => {
  test('parses the redacted real Grok Build update sequence', () => {
    const parsed = parseGrokUpdates(path.join(FIXTURES, 'updates.redacted-real.jsonl'));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({
      promptId: 'prompt-redacted',
      completed: true,
      stopReason: 'error',
    });
    expect(parsed.turns[0].toolStarts).toHaveLength(1);
    expect(parsed.turns[0].toolCompletions).toHaveLength(1);
    expect(parsed.turns[0].toolCompletions[0].toolStatus).toBe('failure');
  });

  test('normalizes real envelope shape, snake_case terminal, and preserves torn tail', () => {
    const { dir, file } = withTempFile([
      {
        timestamp: 1785296758,
        method: 'session/update',
        params: {
          _meta: { eventId: 'e1', agentTimestampMs: 1785296758001 },
          update: {
            sessionUpdate: 'user_message_chunk',
            _meta: { promptIndex: 7, modelId: 'qwen3.7-max' },
            content: { type: 'text', text: 'hello' },
          },
        },
      },
      {
        timestamp: 1785296759,
        method: 'session/update',
        params: {
          _meta: {
            eventId: 'e2',
            agentTimestampMs: 1785296759001,
            turnStartMs: 1785296758000,
            promptId: 'prompt-7',
          },
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: '',
            title: 'Read file',
            rawInput: { path: 'README.md' },
            _meta: { 'x.ai/tool': { name: 'read_file' } },
          },
        },
      },
      {
        timestamp: 1785296760,
        method: 'session/update',
        params: {
          _meta: {
            eventId: 'e3',
            agentTimestampMs: 1785296760000,
            promptId: 'prompt-7',
          },
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: '',
            status: 'in_progress',
            rawOutput: { message: 'partial output' },
          },
        },
      },
      {
        timestamp: 1785296760,
        method: 'session/update',
        params: {
          _meta: {
            eventId: 'e3-final',
            agentTimestampMs: 1785296760123,
            promptId: 'prompt-7',
          },
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: '',
            status: 'Failed',
            rawOutput: { message: 'not found' },
          },
        },
      },
      {
        timestamp: 1785296761,
        method: 'session/update',
        params: {
          _meta: { eventId: 'e4', agentTimestampMs: 1785296761000 },
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-7',
            stop_reason: 'cancelled',
            usage: { inputTokens: 10, outputTokens: 2, modelCalls: 1 },
          },
        },
      },
    ], '{"timestamp":');

    try {
      const parsed = parseGrokUpdates(file);
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]).toMatchObject({
        promptId: 'prompt-7',
        promptIndex: '7',
        completed: true,
        stopReason: 'cancelled',
        startMs: 1785296758000,
        endMs: 1785296761000,
      });
      expect(parsed.turns[0].toolStarts[0]).toMatchObject({
        toolName: 'read_file',
        toolInput: { path: 'README.md' },
      });
      expect(parsed.turns[0].toolCompletions[0]).toMatchObject({
        toolStatus: 'failure',
        toolOutput: { message: 'not found' },
      });
      expect(parsed.turns[0].toolCompletions).toHaveLength(1);
      expect(parsed.checkpoint.offset).toBeLessThan(fs.statSync(file).size);
      expect(parsed.lastCompletedOffset).toBe(parsed.checkpoint.offset);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts camelCase terminal fields and resets an invalid checkpoint after truncation', () => {
    const { dir, file } = withTempFile([
      {
        timestamp: '2026-07-29T03:48:57.000Z',
        params: {
          update: {
            sessionUpdate: 'turnCompleted',
            promptId: 'p-camel',
            stopReason: 'end_turn',
          },
        },
      },
    ]);
    try {
      const first = parseGrokUpdates(file);
      expect(first.turns[0]).toMatchObject({
        promptId: 'p-camel',
        stopReason: 'end_turn',
      });

      fs.writeFileSync(file, `${JSON.stringify({
        timestamp: 1785297000,
        params: { update: { sessionUpdate: 'agent_message_chunk' } },
      })}\n`);
      const second = parseGrokUpdates(file, {
        ...first.checkpoint,
        offset: first.checkpoint.offset + 1000,
      });
      expect(second.reset).toBe(true);
      expect(second.events).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
