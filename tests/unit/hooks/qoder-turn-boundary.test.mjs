import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function runProcessor() {
  return spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: 'session-ide',
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-project',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function readHistory() {
  const historyDir = path.join(dataDir, 'logs', 'qoder', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('qoder-hook-processor turn boundary markers', () => {
  it('marks the user input as turn start and the final llm.response as turn end', () => {
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

    // Both markers share one turn, and the events in between carry neither.
    expect(starts[0]['gen_ai.turn.id']).toBe(ends[0]['gen_ai.turn.id']);
    for (const record of records.slice(1, -1)) {
      expect(record['gen_ai.turn.start']).toBeUndefined();
      expect(record['gen_ai.turn.end']).toBeUndefined();
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
