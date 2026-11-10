import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROCESSOR = path.join(ROOT, 'assets/hooks/grok-build-hook-processor.mjs');
const MARKER = 'agent.pilot.request.attribute.keys';
let root, dataDir, grokHome;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-request-attrs-'));
  dataDir = path.join(root, 'pilot'); grokHome = path.join(root, 'grok');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function appendTurn(session, index, attributes) {
  const sessionDir = path.join(grokHome, 'sessions', encodeURIComponent('/workspace'), session);
  fs.mkdirSync(sessionDir, { recursive: true });
  const chat = path.join(sessionDir, 'chat_history.jsonl');
  const updates = path.join(sessionDir, 'updates.jsonl');
  const prompt = `${session}-prompt-${index}`;
  const start = Date.UTC(2026, 10, 11, 1, 0, 0) + index * 5000;
  const rows = [
    { type: 'user', prompt_index: index, content: `<user_query>task ${index}</user_query>`, timestamp: new Date(start).toISOString() },
    { type: 'assistant', content: `done ${index}`, model_id: 'grok-code-fast-1', timestamp: new Date(start + 1000).toISOString() },
  ];
  fs.appendFileSync(chat, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.appendFileSync(updates, JSON.stringify({ timestamp: start / 1000 + 1,
    params: { _meta: { promptId: prompt, agentTimestampMs: start + 1000, turnStartMs: start },
      update: { sessionUpdate: 'turn_completed', stopReason: 'end_turn', _meta: { promptIndex: index } } },
  }) + '\n');
  const unified = path.join(root, 'unified.jsonl');
  fs.appendFileSync(unified, JSON.stringify({ ts: new Date(start + 100).toISOString(), sid: session,
    msg: 'shell.turn.inference_start', ctx: { loop_index: index + 1 },
  }) + '\n');
  const env = { ...process.env, HOME: root, GROK_HOME: grokHome,
    LOONGSUITE_PILOT_DATA_DIR: dataDir, GROK_UNIFIED_LOG_PATH: unified };
  delete env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  if (attributes !== undefined) env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = attributes;
  const result = spawnSync(process.execPath, [PROCESSOR, 'stop'], {
    input: JSON.stringify({ session_id: session, prompt_id: prompt, transcript_path: updates,
      cwd: '/workspace', timestamp: new Date(start + 2000).toISOString(), stop_reason: 'end_turn' }),
    env, encoding: 'utf8', timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  const dir = path.join(dataDir, 'logs', 'grok-build');
  const records = fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')).flatMap(file =>
    fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  return records.filter(record => record['gen_ai.turn.id'] === prompt);
}

describe('Grok process-scoped request attributes', () => {
  test('takes each spawned process value and clears it on a later turn without env', () => {
    for (const [index, user] of ['U001', 'U002', undefined].entries()) {
      const records = appendTurn('same-native-session', index,
        user === undefined ? undefined : `memory.user_id=${user},memory.request_id=R${index}`);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some(record => record['event.name'] === 'llm.response')).toBe(true);
      for (const record of records) {
        expect(record['memory.user_id']).toBe(user);
        expect(record['memory.request_id']).toBe(user === undefined ? undefined : `R${index}`);
        expect(record[MARKER]).toEqual(user === undefined ? undefined : ['memory.user_id', 'memory.request_id']);
      }
    }
  });

  test('keeps structural fields and fixed resource markers out of caller control', () => {
    const records = appendTurn('safe-session', 0, [
      'memory.user_id=U001', 'gen_ai.session.id=wrong', 'trace_id=wrong',
      'span_id=wrong', 'parent_span_id=wrong', 'resourceAttributes=wrong',
      'timestamp=wrong', 'attributes=wrong', 'constructor=wrong', 'prototype=wrong',
      'memory.password=wrong', 'input.messages=wrong',
    ].join(','));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record['gen_ai.session.id']).toBe('safe-session');
      expect(record.trace_id).toMatch(/^[a-f0-9]{32}$/);
      expect(record['memory.user_id']).toBe('U001');
      expect(record[MARKER]).toEqual(['memory.user_id']);
      expect(Object.values(record)).not.toContain('wrong');
      expect(Object.hasOwn(record, 'constructor')).toBe(false);
    }
  });

  test('does not attach the current caller attributes to an older turn repaired by UPS', () => {
    const session = 'recovery-session';
    const dir = path.join(grokHome, 'sessions', encodeURIComponent('/workspace'), session);
    fs.mkdirSync(dir, { recursive: true });
    const chat = path.join(dir, 'chat_history.jsonl'), updates = path.join(dir, 'updates.jsonl');
    fs.writeFileSync(chat, ''); fs.writeFileSync(updates, '');
    const env = { ...process.env, HOME: root, GROK_HOME: grokHome,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: 'memory.user_id=next-user' };
    const payload = { session_id: session, prompt_id: 'next-prompt', transcript_path: updates,
      cwd: '/workspace', timestamp: '2026-11-11T01:00:05.000Z' };
    const ups = () => spawnSync(process.execPath, [PROCESSOR, 'user_prompt_submit'], {
      input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 10000,
    });
    expect(ups().status).toBe(0);
    fs.appendFileSync(chat, [
      { type: 'user', prompt_index: 0, content: '<user_query>old request</user_query>', timestamp: '2026-11-11T01:00:00.000Z' },
      { type: 'assistant', content: 'partial', model_id: 'grok', timestamp: '2026-11-11T01:00:01.000Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.appendFileSync(updates, JSON.stringify({ timestamp: 1794358801,
      params: { _meta: { promptId: 'old-prompt', agentTimestampMs: 1794358801000 },
        update: { sessionUpdate: 'turn_completed', stopReason: 'cancelled', _meta: { promptIndex: 0 } } },
    }) + '\n');
    const result = ups(); expect(result.status, result.stderr).toBe(0);
    const logDir = path.join(dataDir, 'logs', 'grok-build');
    const records = fs.readdirSync(logDir).filter(file => file.endsWith('.jsonl')).flatMap(file =>
      fs.readFileSync(path.join(logDir, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(record => record['gen_ai.turn.id'] === 'old-prompt')).toBe(true);
    expect(records.every(record => record['memory.user_id'] === undefined && record[MARKER] === undefined)).toBe(true);
  });

  test.each([
    Array.from({ length: 65 }, (_, i) => `memory.key${i}=value`).join(','),
    Array.from({ length: 20 }, (_, i) => `memory.key${i}=${'x'.repeat(500)}`).join(','),
  ])('rejects oversized attribute groups without interrupting the turn', attributes => {
    const records = appendTurn('bounded-session', 0, attributes);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(record => record[MARKER] === undefined)).toBe(true);
    expect(records.every(record => Object.keys(record).every(key => !key.startsWith('memory.')))).toBe(true);
  });
});
