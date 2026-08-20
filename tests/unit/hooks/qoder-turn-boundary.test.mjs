import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyInvocationIdentity,
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
} from '../../../src/normalization/invocation-identity.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../assets/hooks/qoder-hook-processor.mjs');

let dataDir;
let transcriptPath;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-turn-boundary-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function progress(second, hookEvent) {
  return {
    type: 'progress',
    timestamp: `2026-07-20T10:00:${second}.000Z`,
    data: { hookEvent, hookName: 'loongsuite-pilot' },
  };
}

/** One IDE turn: prompt -> tool call -> final answer. */
function ideTurnRows(userExtra = {}) {
  return [
    progress('00', 'UserPromptSubmit'),
    {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-07-20T10:00:01.000Z',
      sessionId: 'session-ide',
      message: { role: 'user', content: 'list the files' },
      ...userExtra,
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: '2026-07-20T10:00:02.000Z',
      sessionId: 'session-ide',
      message: {
        role: 'assistant',
        id: 'message-1',
        model: 'qwen-max',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
        stop_reason: 'tool_use',
      },
    },
    progress('03', 'PreToolUse'),
    progress('04', 'PostToolUse'),
    {
      type: 'user',
      uuid: 'user-2',
      timestamp: '2026-07-20T10:00:05.000Z',
      sessionId: 'session-ide',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.txt' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'assistant-2',
      timestamp: '2026-07-20T10:00:06.000Z',
      sessionId: 'session-ide',
      message: {
        role: 'assistant',
        id: 'message-2',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'there is a.txt' }],
        stop_reason: 'end_turn',
      },
    },
    progress('07', 'Stop'),
    { type: 'last-prompt', sessionId: 'session-ide', lastPrompt: 'list the files' },
  ];
}

function writeTranscript(rows) {
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function runProcessor(agentId = 'qoder', extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, '--agent-id', agentId, '--log-prefix', agentId], {
    input: JSON.stringify({
      session_id: 'session-ide',
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-project',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function readHistory(agentId = 'qoder') {
  const historyDir = path.join(dataDir, 'logs', agentId, 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('qoder-hook-processor turn boundary markers', () => {
  it('marks turn boundaries and preserves tool-call history in the final LLM span', async () => {
    writeTranscript(ideTurnRows());

    expect(runProcessor().status).toBe(0);
    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);
    expect(new Set(records.map(r => r['gen_ai.agent.type']))).toEqual(new Set(['qoder']));

    const starts = records.filter(r => r['gen_ai.turn.start'] === true);
    const ends = records.filter(r => r['gen_ai.turn.end'] === true);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    expect(starts[0]['event.name']).toBe('other');
    expect(starts[0]['gen_ai.input.messages_delta'][0].parts[0].content).toBe('list the files');
    expect(records[0]).toBe(starts[0]);

    expect(ends[0]['event.name']).toBe('llm.response');
    expect(ends[0]['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(records[records.length - 1]).toBe(ends[0]);

    const requests = records.filter(r => r['event.name'] === 'llm.request');
    expect(requests[1]['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          id: 'call-1',
          name: 'Bash',
          arguments: { command: 'ls' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: 'a.txt' }],
      },
    ]);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(records);
      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      const secondInput = JSON.parse(String(
        llmSpans[1]?.attributes['gen_ai.input.messages'],
      ));
      expect(secondInput.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
      expect(secondInput[1].parts[0]).toMatchObject({ type: 'tool_call', id: 'call-1' });
      expect(secondInput[2].parts[0]).toMatchObject({ type: 'tool_call_response', id: 'call-1' });
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }

    // Both markers share one turn, and the events in between carry neither.
    expect(starts[0]['gen_ai.turn.id']).toBe(ends[0]['gen_ai.turn.id']);
    for (const record of records.slice(1, -1)) {
      expect(record['gen_ai.turn.start']).toBeUndefined();
      expect(record['gen_ai.turn.end']).toBeUndefined();
    }
  });

  it('applies invocation-scoped identity to every qoder-cn span', async () => {
    writeTranscript(ideTurnRows());

    expect(runProcessor('qoder-cn', {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
        'gen_ai.session.id=env-session,gen_ai.user.id=env-user',
    }).status).toBe(0);
    const records = readHistory('qoder-cn');
    expect(records.length).toBeGreaterThan(0);
    expect(new Set(records.map(r => r['gen_ai.agent.type']))).toEqual(new Set(['qoder-cn']));
    expect(records.every(r => r[INVOCATION_SESSION_ID_FIELD] === 'env-session')).toBe(true);
    expect(records.every(r => r[INVOCATION_USER_ID_FIELD] === 'env-user')).toBe(true);

    const starts = records.filter(r => r['gen_ai.turn.start'] === true);
    const ends = records.filter(r => r['gen_ai.turn.end'] === true);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    expect(starts[0]['event.name']).toBe('other');
    expect(records[0]).toBe(starts[0]);
    expect(ends[0]['event.name']).toBe('llm.response');
    expect(records[records.length - 1]).toBe(ends[0]);
    expect(starts[0]['gen_ai.turn.id']).toBe(ends[0]['gen_ai.turn.id']);

    for (const record of records.slice(1, -1)) {
      expect(record['gen_ai.turn.start']).toBeUndefined();
      expect(record['gen_ai.turn.end']).toBeUndefined();
    }

    for (const record of records) {
      applyInvocationIdentity(record, 'configured-user', 'fallback-user');
    }
    expect(records.every(r => r['gen_ai.session.id'] === 'env-session')).toBe(true);
    expect(records.every(r => r['user.id'] === 'env-user')).toBe(true);
    expect(records.every(r => !(INVOCATION_SESSION_ID_FIELD in r))).toBe(true);
    expect(records.every(r => !(INVOCATION_USER_ID_FIELD in r))).toBe(true);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    try {
      const conversion = await convertEventLogToReadableSpans(records);
      expect(conversion.spans.length).toBeGreaterThan(0);
      expect(conversion.spans.every(span =>
        span.attributes['gen_ai.session.id'] === 'env-session'
        && span.attributes['gen_ai.user.id'] === 'env-user')).toBe(true);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
    }
  });

  it('leaves qoder-cli turns unmarked', () => {
    writeTranscript(ideTurnRows({ entrypoint: 'cli' }));

    expect(runProcessor().status).toBe(0);
    const records = readHistory();
    expect(new Set(records.map(r => r['gen_ai.agent.type']))).toEqual(new Set(['qoder-cli']));
    expect(records.some(r => 'gen_ai.turn.start' in r || 'gen_ai.turn.end' in r)).toBe(false);
  });
});
