// gen_ai.system_instructions is read from chat_history on demand and emitted
// once on the first llm.request of each trace. It is never persisted in state.
//
// Fixture: tests/unit/hooks/grok-build/fixtures/f3-system-prompt.txt — copied
// from researcher CP1 attachment research-fixtures.tar.gz:f3-system-prompt.txt
// (comment 47a8af1f, 2026-07-17; real grok 0.2.101 system_prompt.txt 5077B).
//
// Test coverage:
//   - Array.isArray(system_instructions)
//   - length === 1
//   - [0].type === 'text'
//   - [0].content === <full 5077B system prompt from fixture>
//   - Exactly one copy per trace, on the first llm.request
//   - No prompt content in state
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/grok-build-hook-processor.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const SYSTEM_PROMTEXT_PATH = path.join(FIXTURES, 'f3-system-prompt.txt');

let DATA_DIR;
let SESSION_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-sys-data-'));
  SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-sys-sess-'));
});

afterEach(() => {
  for (const d of [DATA_DIR, SESSION_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function readSystemPromptFixture() {
  return fs.readFileSync(SYSTEM_PROMTEXT_PATH, 'utf-8');
}

function writeChatHistory(systemPrompt, options = {}) {
  const { numTurns = 1 } = options;
  const records = [
    { type: 'system', content: systemPrompt },
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>' }] },
  ];
  for (let i = 0; i < numTurns; i++) {
    records.push({
      type: 'user',
      content: [{ type: 'text', text: `<user_query>\nTurn ${i + 1}.\n</user_query>` }],
      prompt_index: i,
      timestamp: `2026-07-17T1${i}:00:00.000Z`.replace(/T1(\d):/, (m, d) => `T1${d}:`),
    });
    records.push({
      type: 'assistant',
      content: [{ type: 'text', text: `answer ${i + 1}` }],
      model: 'grok-3',
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: i === numTurns - 1 ? 'end_turn' : 'tool_use',
      timestamp: `2026-07-17T1${i}:00:02.000Z`,
    });
  }
  const target = path.join(SESSION_DIR, 'chat_history.jsonl');
  fs.writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return path.join(SESSION_DIR, 'updates.jsonl');
}

function runHook(payload, extraEnv = {}) {
  const inputPayload = payload?.session_id && payload.prompt_id === undefined
    ? { prompt_id: `${payload.session_id}:turn:1`, ...payload }
    : payload;
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify(inputPayload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('error'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push(JSON.parse(t));
    }
  }
  return out;
}

function readState(sessionId) {
  const f = path.join(DATA_DIR, 'state', 'grok-build', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

describe('grok-build F3a — gen_ai.system_instructions array on first AGENT span', () => {
  test('single-turn — AGENT span carries array system_instructions with full fixture content', () => {
    const systemPrompt = readSystemPromptFixture();
    const transcriptPath = writeChatHistory(systemPrompt, { numTurns: 1 });
    const r = runHook({
      session_id: 's-sys-single',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:02.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const withSys = records.filter((rec) => Array.isArray(rec['gen_ai.system_instructions']));
    expect(withSys.length).toBe(1);
    expect(withSys[0]['event.name']).toBe('llm.request');

    // Every record in the first turn's AGENT span (all records share baseFields for turn 1)
    // carries the array — assert shape and content.
    for (const rec of withSys) {
      const si = rec['gen_ai.system_instructions'];
      expect(Array.isArray(si)).toBe(true);
      expect(si.length).toBe(1);
      expect(si[0].type).toBe('text');
      expect(si[0].content).toBe(systemPrompt);
    }

    // Spot-check the first record (the AGENT span / prompt delta) specifically.
    const first = withSys[0];
    expect(first['gen_ai.system_instructions'][0].content).toBe(systemPrompt);
    expect(first['gen_ai.system_instructions'][0].content.length).toBe(systemPrompt.length);

    const state = readState('s-sys-single');
    expect(state).not.toHaveProperty('system_prompt');
  });

  test('multi-turn session — system_instructions emitted once per trace', () => {
    const systemPrompt = readSystemPromptFixture();
    const chatPath = path.join(SESSION_DIR, 'chat_history.jsonl');
    const transcriptPath = path.join(SESSION_DIR, 'updates.jsonl');
    const basePayload = {
      session_id: 's-sys-multi',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      cwd: '/tmp',
    };

    // Turn 1 alone — emitted as first turn (carries system_instructions)
    fs.writeFileSync(chatPath, [
      { type: 'system', content: systemPrompt },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>' }] },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nTurn 1.\n</user_query>' }],
        prompt_index: 0,
        timestamp: '2026-07-17T10:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'answer 1' }],
        model: 'grok-3',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T10:00:02.000Z',
      },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    let r = runHook({ ...basePayload, timestamp: '2026-07-17T10:00:02.500Z' });
    expect(r.status).toBe(0);

    const recordsBatch1 = readJsonlRecords();
    const turn1 = recordsBatch1.filter((rec) =>
      (rec['gen_ai.turn.id'] || '').endsWith(':turn:1'));
    expect(turn1.length).toBeGreaterThan(0);
    const t1WithSys = turn1.filter((rec) => Array.isArray(rec['gen_ai.system_instructions']));
    expect(t1WithSys.length).toBe(1);
    expect(t1WithSys[0]['event.name']).toBe('llm.request');
    for (const rec of t1WithSys) {
      const si = rec['gen_ai.system_instructions'];
      expect(Array.isArray(si)).toBe(true);
      expect(si.length).toBe(1);
      expect(si[0].type).toBe('text');
      expect(si[0].content).toBe(systemPrompt);
    }

    // Append turn 2 and run second cmdStop (state.turn_count == 1 → not first run)
    fs.appendFileSync(chatPath, [
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nTurn 2.\n</user_query>' }],
        prompt_index: 1,
        timestamp: '2026-07-17T11:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'answer 2' }],
        model: 'grok-3',
        usage: { input_tokens: 20, output_tokens: 5 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T11:00:02.000Z',
      },
    ].map((r2) => JSON.stringify(r2)).join('\n') + '\n');

    // Clear DATA_DIR logs so we can read only the new batch (state is preserved)
    const logDir = path.join(DATA_DIR, 'logs', 'grok-build');
    for (const f of fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'))) {
      fs.unlinkSync(path.join(logDir, f));
    }

    r = runHook({
      ...basePayload,
      prompt_id: 's-sys-multi:turn:2',
      timestamp: '2026-07-17T11:00:02.500Z',
    });
    expect(r.status).toBe(0);
    const recordsBatch2 = readJsonlRecords();
    const turn2 = recordsBatch2.filter((rec) =>
      (rec['gen_ai.turn.id'] || '').endsWith(':turn:2'));
    expect(turn2.length).toBeGreaterThan(0);
    // Turn 2 is a separate trace and carries one copy.
    const t2WithSys = turn2.filter((rec) => Array.isArray(rec['gen_ai.system_instructions']));
    expect(t2WithSys.length).toBe(1);
    expect(t2WithSys[0]['event.name']).toBe('llm.request');
  });

  test('incremental cmdStop — state excludes prompt content and each trace gets one copy', () => {
    const systemPrompt = readSystemPromptFixture();
    const transcriptPath = writeChatHistory(systemPrompt, { numTurns: 1 });
    const basePayload = {
      session_id: 's-sys-incr',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      cwd: '/tmp',
    };

    // First stop — emit turn 1
    let r = runHook({ ...basePayload, timestamp: '2026-07-17T10:00:02.500Z' });
    expect(r.status).toBe(0);
    const state1 = readState('s-sys-incr');
    expect(state1.turn_count).toBe(1);
    expect(state1).not.toHaveProperty('system_prompt');

    const records1 = readJsonlRecords();
    const t1WithSys1 = records1.filter((rec) =>
      (rec['gen_ai.turn.id'] || '').endsWith(':turn:1')
      && Array.isArray(rec['gen_ai.system_instructions']));
    expect(t1WithSys1.length).toBe(1);

    // Append turn 2 to chat_history
    const chatPath = path.join(SESSION_DIR, 'chat_history.jsonl');
    fs.appendFileSync(chatPath, [
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nTurn 2.\n</user_query>' }],
        prompt_index: 1,
        timestamp: '2026-07-17T11:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'answer 2' }],
        model: 'grok-3',
        usage: { input_tokens: 20, output_tokens: 5 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T11:00:02.000Z',
      },
    ].map((r2) => JSON.stringify(r2)).join('\n') + '\n');

    // Clear DATA_DIR logs so we can read only the new batch (state is preserved)
    const logDir = path.join(DATA_DIR, 'logs', 'grok-build');
    for (const f of fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'))) {
      fs.unlinkSync(path.join(logDir, f));
    }

    // Second stop — turn 2 only (offset advanced)
    r = runHook({
      ...basePayload,
      prompt_id: 's-sys-incr:turn:2',
      timestamp: '2026-07-17T11:00:02.500Z',
    });
    expect(r.status).toBe(0);
    const state2 = readState('s-sys-incr');
    expect(state2.turn_count).toBe(2);

    const records2 = readJsonlRecords();
    const t2 = records2.filter((rec) =>
      (rec['gen_ai.turn.id'] || '').endsWith(':turn:2'));
    expect(t2.length).toBeGreaterThan(0);
    // The second batch is another trace and gets one copy on its first request.
    const t2WithSys = t2.filter((rec) => Array.isArray(rec['gen_ai.system_instructions']));
    expect(t2WithSys.length).toBe(1);
    expect(t2WithSys[0]['event.name']).toBe('llm.request');
  });

  test('chat_history without system record — system_instructions absent, no crash', () => {
    // chat_history without type:system record at all
    const records = [
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>' }] },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }],
        prompt_index: 0,
        timestamp: '2026-07-17T10:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        model: 'grok-3',
        usage: { input_tokens: 10, output_tokens: 2 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T10:00:02.000Z',
      },
    ];
    const target = path.join(SESSION_DIR, 'chat_history.jsonl');
    fs.writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const transcriptPath = path.join(SESSION_DIR, 'updates.jsonl');

    const r = runHook({
      session_id: 's-sys-nosystem',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:02.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records2 = readJsonlRecords();
    const withSys = records2.filter((rec) => Array.isArray(rec['gen_ai.system_instructions']));
    expect(withSys.length).toBe(0);
  });
});
