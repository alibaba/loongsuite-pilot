import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGrokTranscript } from '../../../../assets/hooks/grok-build/transcript-parser.mjs';
import { parseGrokUpdates } from '../../../../assets/hooks/grok-build/updates-parser.mjs';
import {
  MAX_UNIFIED_BYTES,
  parseGrokUnified,
  selectUnifiedGroups,
} from '../../../../assets/hooks/grok-build/unified-parser.mjs';
import { fuseGrokTurn } from '../../../../assets/hooks/grok-build/fusion.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CHAT = path.join(FIXTURES, 'chat_history.redacted-real.jsonl');
const UPDATES = path.join(FIXTURES, 'updates.redacted-real.jsonl');
const UNIFIED = path.join(FIXTURES, 'unified.redacted-real.jsonl');

describe('Grok Build three-source reconstruction', () => {
  test('bounds the shared unified-log scan close to Grok Build native rotation size', () => {
    expect(MAX_UNIFIED_BYTES).toBe(8 * 1024 * 1024);
  });

  test('parses the compact redacted source rails and keeps torn JSONL for retry', () => {
    const chat = parseGrokTranscript(CHAT);
    expect(chat.systemPrompt).toContain('Grok Build');
    expect(chat.turns).toHaveLength(1);
    expect(chat.turns[0].prompt).toBe('Read two files.');
    expect(chat.turns[0].llmCalls[0].declaredToolIds).toHaveLength(2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-updates-tail-'));
    const copied = path.join(dir, 'updates.jsonl');
    const complete = fs.readFileSync(UPDATES, 'utf8');
    fs.writeFileSync(copied, `${complete}{"params":`, 'utf8');
    try {
      const parsed = parseGrokUpdates(copied);
      expect(parsed.parseErrors).toBe(0);
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]).toMatchObject({
        promptId: 'prompt-redacted',
        completed: true,
        stopReason: 'end_turn',
      });
      expect(parsed.checkpoint.offset).toBe(Buffer.byteLength(complete));
      expect(parsed.turns[0].toolCompletions.map(event => event.toolStatus))
        .toEqual(['failure', 'success']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const unified = parseGrokUnified(UNIFIED, 'session-redacted');
    expect(unified.parseErrors).toBe(0);
    expect(unified.groups).toHaveLength(1);
    expect(unified.groups[0]).toMatchObject({
      loopIndex: 1,
      modelElapsedMs: 5206,
      promptTokens: 10244,
      cachedPromptTokens: 8448,
      completionTokens: 237,
    });
    expect(unified.groups[0].tools.map(tool => tool.elapsedMs)).toEqual([125, 0]);
  });

  test('fuses parallel same-name tools by source order without inventing IDs, results, or time', () => {
    const chat = parseGrokTranscript(CHAT);
    const updates = parseGrokUpdates(UPDATES);
    const unified = parseGrokUnified(UNIFIED, 'session-redacted');
    const fused = fuseGrokTurn({
      chatTurn: chat.turns[0],
      updateTurn: updates.turns[0],
      unifiedGroups: unified.groups,
      promptId: 'prompt-redacted',
      stopReason: 'end_turn',
      hookTimestampMs: Date.parse('2026-07-29T03:48:59.000Z'),
    });

    expect(fused.llmCalls).toHaveLength(1);
    const llm = fused.llmCalls[0];
    expect(llm).toMatchObject({
      requestStartMs: Date.parse('2026-07-29T03:48:52.621Z'),
      responseEndMs: Date.parse('2026-07-29T03:48:57.827Z'),
      input_tokens: 10244,
      output_tokens: 237,
      finishReason: 'tool_use',
      timingSource: 'unified',
    });
    expect(llm.tools).toHaveLength(2);
    expect(llm.tools[0]).toMatchObject({
      id: 'tool-a',
      status: 'failure',
      durationMs: 125,
      matchStrategy: 'name_order',
      timingSource: 'unified',
      resultPresent: true,
    });
    expect(llm.tools[1]).toMatchObject({
      id: 'tool-b',
      status: 'success',
      durationMs: 0,
      matchStrategy: 'name_order',
      timingSource: 'unified',
      resultPresent: true,
    });
    expect(llm.output_content.filter(block => block.type === 'tool_use').map(block => block.id))
      .toEqual(['tool-a', 'tool-b']);
    expect(JSON.stringify(fused)).not.toContain('no tool_result recorded');
  });

  test('keeps a completed inference when cancellation leaves a trailing start', () => {
    const completed = { loopIndex: 1, startMs: 1000, endMs: 1500, tools: [] };
    const trailing = { loopIndex: 2, startMs: 1500, endMs: null, tools: [] };
    expect(selectUnifiedGroups([completed, trailing], {
      startMs: 900,
      endMs: 2000,
      expectedCount: 1,
    })).toEqual([completed]);
  });

  test('leaves a differently named tool unmatched instead of consuming unrelated evidence', () => {
    const fused = fuseGrokTurn({
      chatTurn: {
        prompt: 'run a command',
        llmCalls: [{
          protocol: 'anthropic',
          message_id: 'response-1',
          input_messages: [],
          output_content: [{
            type: 'tool_use',
            id: 'shell_1_1',
            source_id: null,
            name: 'shell',
            input: { command: 'pwd' },
          }],
          declaredToolIds: ['shell_1_1'],
          toolDetails: new Map(),
        }],
      },
      updateTurn: { startMs: 1000, endMs: 3000, completed: true },
      unifiedGroups: [{
        loopIndex: 1,
        startMs: 1100,
        endMs: 1500,
        tools: [{
          name: 'read_file',
          startMs: 1600,
          endMs: 1700,
          elapsedMs: 100,
          success: true,
        }],
      }],
      promptId: 'prompt-mismatch',
      stopReason: 'end_turn',
      hookTimestampMs: 3000,
    });

    expect(fused.llmCalls[0].tools[0]).toMatchObject({
      id: 'prompt-mismatch:l1:t1',
      status: 'unknown',
      matchStrategy: 'unmatched',
      timingSource: 'hook',
      resultPresent: false,
    });
    expect(fused.llmCalls[0].tools[0].durationMs).toBe(0);
    expect(fused.llmCalls[0].output_content[0].id).toBe('prompt-mismatch:l1:t1');
  });

  test('does not use a unified array index to attach an unidentified update completion', () => {
    const fused = fuseGrokTurn({
      chatTurn: {
        prompt: 'run a command',
        llmCalls: [{
          protocol: 'anthropic',
          message_id: 'response-1',
          input_messages: [],
          output_content: [{
            type: 'tool_use',
            id: 'shell_1_1',
            source_id: null,
            name: 'shell',
            input: { command: 'pwd' },
          }],
          declaredToolIds: ['shell_1_1'],
          toolDetails: new Map(),
        }],
      },
      updateTurn: {
        startMs: 1000,
        endMs: 3000,
        completed: true,
        toolStarts: [],
        toolCompletions: [{
          timestampMs: 1900,
          toolId: '',
          toolName: null,
          toolStatus: 'failure',
          toolOutput: 'result from a different tool',
        }],
      },
      unifiedGroups: [{
        loopIndex: 1,
        startMs: 1100,
        endMs: 1500,
        tools: [{
          name: 'shell',
          startMs: 1600,
          endMs: 1700,
          elapsedMs: 100,
          success: true,
        }],
      }],
      promptId: 'prompt-no-cross-index',
      stopReason: 'end_turn',
      hookTimestampMs: 3000,
    });

    expect(fused.llmCalls[0].tools[0]).toMatchObject({
      status: 'success',
      resultPresent: false,
      matchStrategy: 'name_order',
      timingSource: 'unified',
    });
    expect(fused.llmCalls[0].tools[0].result).toBeUndefined();
  });

  test('reads promptIndex from params metadata when update metadata omits it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-updates-prompt-index-'));
    const file = path.join(dir, 'updates.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: 1785296939,
      params: {
        _meta: {
          promptId: 'prompt-params-meta',
          promptIndex: 7,
          agentTimestampMs: 1785296939000,
        },
        update: {
          sessionUpdate: 'turn_completed',
          stopReason: 'end_turn',
        },
      },
    }) + '\n');
    try {
      expect(parseGrokUpdates(file).turns[0]).toMatchObject({
        promptId: 'prompt-params-meta',
        promptIndex: '7',
        completed: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps inference_done timing when Grok omits usage instead of inventing zero tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-unified-no-usage-'));
    const file = path.join(dir, 'unified.jsonl');
    fs.writeFileSync(file, [
      { ts: '2026-07-29T03:48:52.000Z', sid: 'no-usage', msg: 'shell.turn.inference_start', ctx: { loop_index: 1 } },
      { ts: '2026-07-29T03:48:53.000Z', sid: 'no-usage', msg: 'shell.turn.inference_done', ctx: { loop_index: 1, model_elapsed_ms: 1000, prompt_tokens: null, completion_tokens: null } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    try {
      const group = parseGrokUnified(file, 'no-usage').groups[0];
      expect(group.endMs - group.startMs).toBe(1000);
      expect(group.promptTokens).toBeNull();
      expect(group.completionTokens).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates an incomplete failed LLM only when inference_start is observed', () => {
    const withAttempt = fuseGrokTurn({
      chatTurn: { prompt: 'hello', llmCalls: [] },
      updateTurn: { promptIndex: '0', startMs: 1000, endMs: null },
      unifiedGroups: [{ loopIndex: 1, startMs: 1100, endMs: null, tools: [] }],
      promptId: 'prompt-failure',
      stopReason: 'error',
      hookTimestampMs: 1200,
    });
    expect(withAttempt.llmCalls).toHaveLength(1);
    expect(withAttempt.llmCalls[0]).toMatchObject({ incomplete: true, finishReason: 'error' });

    const withoutAttempt = fuseGrokTurn({
      chatTurn: { prompt: 'hello', llmCalls: [] },
      updateTurn: { promptIndex: '0', startMs: 1000, endMs: null },
      unifiedGroups: [],
      promptId: 'prompt-failure',
      stopReason: 'error',
      hookTimestampMs: 1200,
    });
    expect(withoutAttempt.llmCalls).toHaveLength(0);
  });
});
