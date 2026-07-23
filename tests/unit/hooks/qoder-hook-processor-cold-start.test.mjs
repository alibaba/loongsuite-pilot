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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-hook-cold-start-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function turnRows(index, prompt) {
  const second = String(10 + index * 2).padStart(2, '0');
  return [
    {
      type: 'user',
      uuid: `user-${index}`,
      timestamp: `2026-07-20T10:00:${second}.000Z`,
      sessionId: 'session-old',
      entrypoint: 'cli',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: `assistant-${index}`,
      timestamp: `2026-07-20T10:00:${second}.500Z`,
      sessionId: 'session-old',
      message: {
        role: 'assistant',
        id: `message-${index}`,
        content: [{ type: 'text', text: `answer ${index}` }],
        stop_reason: 'end_turn',
      },
    },
  ];
}

function lastPrompt(index) {
  return { type: 'last-prompt', sessionId: 'session-old', lastPrompt: `prompt ${index}` };
}

function runProcessor(sessionId = 'session-old') {
  return spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: sessionId,
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

function userBoundaryPrompts(records) {
  return records
    .filter(record => record['event.name'] === 'other' && record['agent.qoder.raw_type'] === 'user')
    .map(record => record['gen_ai.input.messages_delta']?.[0]?.parts?.[0]?.content);
}

describe('qoder-hook-processor cold-start recovery', () => {
  it('does not replay old turns when each old session first appears after redeployment', () => {
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'historical prompt 1'),
      ...turnRows(2, 'historical prompt 2'),
      lastPrompt(2),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const first = runProcessor();
    expect(first.status).toBe(0);
    const bootstrapRecords = readHistory();
    expect(userBoundaryPrompts(bootstrapRecords)).toEqual(['historical prompt 2']);
    expect(new Set(bootstrapRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['bootstrap']),
    );
    expect(new Set(bootstrapRecords.map(r => r['agent.transcript.cursor_reason']))).toEqual(
      new Set(['missing-cursor']),
    );

    const cursorDir = path.join(dataDir, 'state', 'hooks', 'qoder-line-records');
    expect(fs.readdirSync(cursorDir).filter(file => file.endsWith('.json'))).toHaveLength(1);

    const before = bootstrapRecords.length;
    fs.appendFileSync(transcriptPath, [
      ...turnRows(3, 'new prompt 3'),
      lastPrompt(3),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const second = runProcessor();
    expect(second.status).toBe(0);
    const incrementalRecords = readHistory().slice(before);
    expect(userBoundaryPrompts(incrementalRecords)).toEqual(['new prompt 3']);
    expect(new Set(incrementalRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['incremental']),
    );

    // A different pre-existing transcript may be opened much later, after the
    // global Trace Input offset is already active. It must get its own recovery
    // decision instead of inheriting the first transcript's initialized state.
    const beforeSecondSession = readHistory().length;
    transcriptPath = path.join(dataDir, 'second-old-transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      ...turnRows(4, 'second session historical prompt 4'),
      ...turnRows(5, 'second session historical prompt 5'),
      lastPrompt(5),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const third = runProcessor('session-second-old');
    expect(third.status).toBe(0);
    const secondSessionRecords = readHistory().slice(beforeSecondSession);
    expect(userBoundaryPrompts(secondSessionRecords)).toEqual([
      'second session historical prompt 5',
    ]);
    expect(new Set(secondSessionRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['bootstrap']),
    );
    const cursorFiles = fs.readdirSync(cursorDir).filter(file => file.endsWith('.json'));
    expect(cursorFiles).toHaveLength(2);
    const persistedSessionIds = cursorFiles.map(file =>
      JSON.parse(fs.readFileSync(path.join(cursorDir, file), 'utf-8')).session_id
    );
    expect(new Set(persistedSessionIds)).toEqual(
      new Set(['session-old', 'session-second-old']),
    );
  });
});
