import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGrokUnified,
  selectUnifiedGroups,
} from '../../../../assets/hooks/grok-build/unified-parser.mjs';
import { fuseGrokTurn } from '../../../../assets/hooks/grok-build/fusion.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('Grok unified parser + three-source fusion', () => {
  test('parses redacted real unified inference and tool telemetry', () => {
    const parsed = parseGrokUnified(
      path.join(FIXTURES, 'unified.redacted-real.jsonl'),
      'session-redacted',
    );
    expect(parsed.parseErrors).toBe(0);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]).toMatchObject({
      loopIndex: 1,
      modelElapsedMs: 5206,
      promptTokens: 10244,
      cachedPromptTokens: 8448,
      completionTokens: 237,
    });
    expect(parsed.groups[0].tools[0]).toMatchObject({
      name: 'read_file',
      elapsedMs: 125,
      success: false,
    });
  });

  test('keeps the completed inference when cancellation leaves a trailing inference_start', () => {
    const groups = [
      {
        loopIndex: 1,
        startMs: 1000,
        endMs: 1500,
        promptTokens: 100,
        completionTokens: 20,
        tools: [{ name: 'todo_write', startMs: 1500, endMs: 1500, elapsedMs: 0 }],
      },
      {
        loopIndex: 2,
        startMs: 1500,
        endMs: null,
        promptTokens: 0,
        completionTokens: 0,
        tools: [],
      },
    ];

    expect(selectUnifiedGroups(groups, {
      startMs: 1000,
      endMs: 2000,
      expectedCount: 1,
    })).toEqual([groups[0]]);
  });

  test('uses real LLM/tool clocks, tokens, failed status, and attributable result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-unified-fusion-'));
    const file = path.join(dir, 'unified.jsonl');
    const sid = 'session-fusion';
    const unifiedRecords = [
      {
        ts: '2026-07-29T03:48:52.621Z',
        sid,
        msg: 'shell.turn.inference_start',
        ctx: { loop_index: 1, elapsed_since_turn_start_ms: 1 },
      },
      {
        ts: '2026-07-29T03:48:57.827Z',
        sid,
        msg: 'shell.turn.inference_done',
        ctx: {
          loop_index: 1,
          model_elapsed_ms: 5206,
          prompt_tokens: 10244,
          cached_prompt_tokens: 8448,
          completion_tokens: 237,
          reasoning_tokens: 10,
        },
      },
      {
        ts: '2026-07-29T03:48:58.000Z',
        sid,
        msg: 'shell.tool.exec_done',
        ctx: { tool_name: 'read_file', elapsed_ms: 125, success: false },
      },
    ];
    fs.writeFileSync(
      file,
      unifiedRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf-8',
    );

    try {
      const unified = parseGrokUnified(file, sid);
      expect(unified.groups).toHaveLength(1);

      const toolId = 'read_file_1_1';
      const chatTurn = {
        promptIndex: '0',
        prompt: 'read it',
        promptTimestamp: '2026-07-29T03:48:52.600Z',
        llmCalls: [{
          message_id: 'm1',
          protocol: 'anthropic',
          model: 'qwen3.7-max',
          input_messages: [{ role: 'user', content: 'read it' }],
          _input_is_delta: true,
          output_content: [{
            type: 'tool_use',
            id: toolId,
            source_id: null,
            name: 'read_file',
            input: { path: 'README.md' },
          }],
          declaredToolIds: [toolId],
          toolDetails: new Map([[toolId, {
            call: null,
            result: null,
            resultContent: undefined,
            hasResult: false,
            isError: false,
          }]]),
          input_tokens: 0,
          output_tokens: 0,
        }],
      };
      const updateTurn = {
        promptId: 'prompt-fusion',
        promptIndex: '0',
        startMs: Date.parse('2026-07-29T03:48:52.600Z'),
        endMs: Date.parse('2026-07-29T03:48:58.100Z'),
        toolStarts: [{
          timestampMs: Date.parse('2026-07-29T03:48:57.830Z'),
          toolId: '',
          toolName: 'read_file',
          toolInput: { path: 'README.md' },
        }],
        toolCompletions: [{
          timestampMs: Date.parse('2026-07-29T03:48:58.000Z'),
          toolId: '',
          toolStatus: 'failure',
          toolOutput: { message: 'not found' },
        }],
      };

      const fused = fuseGrokTurn({
        chatTurn,
        updateTurn,
        unifiedGroups: unified.groups,
        promptId: 'prompt-fusion',
        stopReason: 'end_turn',
        hookTimestampMs: Date.parse('2026-07-29T03:48:58.100Z'),
      });
      const llm = fused.llmCalls[0];
      expect(llm.requestStartMs).toBe(Date.parse('2026-07-29T03:48:52.621Z'));
      expect(llm.responseEndMs).toBe(Date.parse('2026-07-29T03:48:57.827Z'));
      expect(llm.input_tokens).toBe(10244);
      expect(llm.cache_read_input_tokens).toBe(8448);
      expect(llm.output_tokens).toBe(237);
      expect(llm.finishReason).toBe('tool_use');

      expect(llm.tools[0]).toMatchObject({
        id: 'prompt-fusion:l1:t1',
        name: 'read_file',
        status: 'failure',
        durationMs: 125,
        matchStrategy: 'name_order',
        timingSource: 'unified',
        resultPresent: true,
        result: { message: 'not found' },
      });
      expect(llm.tools[0].startMs).toBe(Date.parse('2026-07-29T03:48:57.875Z'));
      expect(llm.tools[0].endMs).toBe(Date.parse('2026-07-29T03:48:58.000Z'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps unknown tool completion without fabricating result content', () => {
    const toolId = 'shell_1_1';
    const fused = fuseGrokTurn({
      chatTurn: {
        prompt: 'run',
        llmCalls: [{
          output_content: [{
            type: 'tool_use',
            id: toolId,
            source_id: null,
            name: 'shell',
            input: { command: 'true' },
          }],
          declaredToolIds: [toolId],
          toolDetails: new Map([[toolId, { hasResult: false, isError: false }]]),
          input_messages: [],
          _input_is_delta: true,
        }],
      },
      updateTurn: null,
      unifiedGroups: [],
      promptId: 'p-unknown',
      stopReason: 'end_turn',
      hookTimestampMs: 1000,
    });
    expect(fused.llmCalls[0].tools[0]).toMatchObject({
      status: 'unknown',
      resultPresent: false,
      matchStrategy: 'unmatched',
      timingSource: 'hook',
    });
    expect(JSON.stringify(fused)).not.toContain('no tool_result recorded');
  });

  test('prefers a real tool ID and falls back to update/hook clocks without synthetic duration', () => {
    const toolId = 'tool-real-id';
    const fused = fuseGrokTurn({
      chatTurn: {
        prompt: 'read',
        llmCalls: [{
          output_content: [{
            type: 'tool_use',
            id: toolId,
            source_id: toolId,
            name: 'read_file',
            input: { path: 'README.md' },
          }],
          declaredToolIds: [toolId],
          toolDetails: new Map([[toolId, { hasResult: false, isError: false }]]),
          input_messages: [],
          _input_is_delta: true,
        }],
      },
      updateTurn: {
        completed: true,
        startMs: 1000,
        endMs: 1400,
        toolStarts: [{
          timestampMs: 1200,
          toolId,
          toolName: 'read_file',
          toolInput: { path: 'README.md' },
        }],
        toolCompletions: [{
          timestampMs: 1300,
          toolId,
          toolStatus: 'success',
          toolOutput: 'ok',
        }],
      },
      unifiedGroups: [],
      promptId: 'p-real-id',
      stopReason: 'end_turn',
      hookTimestampMs: 1500,
    });

    expect(fused.llmCalls[0]).toMatchObject({
      requestStartMs: 1000,
      responseEndMs: 1200,
      timingSource: 'updates',
    });
    expect(fused.llmCalls[0].tools[0]).toMatchObject({
      id: toolId,
      startMs: 1200,
      endMs: 1300,
      durationMs: 100,
      matchStrategy: 'id',
      timingSource: 'updates',
      status: 'success',
    });
  });
});
