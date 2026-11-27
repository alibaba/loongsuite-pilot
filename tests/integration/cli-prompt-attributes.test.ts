import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { InvocationAttributeStore } from '../../assets/hooks/shared/invocation-attribute-store.mjs';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { ClientType } from '../../src/types/index.js';

it.each([
  ['claude-code', ClientType.ClaudeCliHook], ['qwen-code-cli', ClientType.QwenCodeCli],
])('%s restores each native prompt snapshot across missed Stop and new Hook processes', async (agent, type) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-prompt-attr-'));
  const processor = path.resolve('assets/hooks', agent + '-hook-processor.mjs');
  const sessionId = 'same-session';
  const transcript = path.join(dataDir, sessionId + '.jsonl');
  function hook(command: string, promptId: string, user?: string, id = promptId) {
    const result = spawnSync(process.execPath, [processor, command], {
      env: {
        ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir,
        AGENT_DATA_COLLECTION_CONFIG: path.join(dataDir, 'config.json'),
        LOONGSUITE_PILOT_INVOCATION_ID: id,
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: user ? 'memory.user_id=' + user : '',
      },
      input: JSON.stringify({
        session_id: sessionId, prompt_id: promptId, submitted_prompt: 'same input',
        transcript_path: transcript, stop_reason: 'end_turn',
      }), encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
  }
  function append(promptId: string, index: number) {
    const t = (s: number) => new Date(Date.UTC(2026, 10, 27, 2, index, s)).toISOString();
    const records = agent === 'claude-code' ? [
      { type: 'user', uuid: 'u-' + promptId, promptId, timestamp: t(0), message: { content: [{ type: 'text', text: 'same input' }] } },
      { type: 'assistant', uuid: 'a-' + promptId, promptId, timestamp: t(1), message: {
        id: promptId, model: 'fixture', content: [{ type: 'text', text: 'reply' }],
        usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: 'end_turn',
      } },
    ] : [
      { type: 'user', uuid: 'u-' + promptId, promptId, sessionId, timestamp: t(0), message: { role: 'user', parts: [{ text: 'same input' }] } },
      { type: 'assistant', uuid: 'a-' + promptId, promptId, sessionId, timestamp: t(1), model: 'fixture',
        message: { role: 'model', parts: [{ text: 'reply' }] }, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      },
    ];
    fs.appendFileSync(transcript, records.map(x => JSON.stringify(x)).join('\n') + '\n');
  }
  try {
    hook('user-prompt-submit', 'native-a', 'A');
    append('native-a', 1);
    // No Stop for A, not even on the first turn after installation.
    hook('user-prompt-submit', 'native-b', 'B');
    append('native-b', 2);
    hook('stop', 'native-b', 'B');
    append('native-missing', 3);
    hook('stop', 'native-missing', 'do-not-use-ambient-env');
    hook('stop', 'native-missing', 'duplicate');
    const logDir = path.join(dataDir, 'logs', agent);
    const rows = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
    const normalized = await Promise.all(rows.map(record =>
      transformHookRecord(record, type, agent, { preserveInvocationAttributes: true })));
    for (const [n, owner] of [[1, 'A'], [2, 'B'], [3, undefined]] as const) {
      const group = normalized.filter(r => r?.['gen_ai.turn.id'] === sessionId + ':t' + n);
      expect(group.filter(r => r?.['event.name'] === 'llm.response')).toHaveLength(1);
      expect(group.every(r => r?.['memory.user_id'] === owner && !Object.hasOwn(r!, 'pilot.invocation.attributes'))).toBe(true);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 15000);

it('seals host-reused prompt IDs without reassigning the earlier attributes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-prompt-reuse-'));
  const selector = { kind: 'turn' as const, sessionId: 'session', turnId: 'native' };
  const key = { agent: 'qwen-code-cli', selector };
  let store = new InvocationAttributeStore({ root });
  try {
    expect(store.registerObservedPrompt({ ...key, invocationId: 'A', attributes: { 'memory.user_id': 'A' } })).toBe('stored');
    expect(store.registerObservedPrompt({ ...key, invocationId: 'B', attributes: { 'memory.user_id': 'B' } })).toBe('ambiguous');
    store.close();
    store = new InvocationAttributeStore({ root });
    expect(store.resolve(key)).toMatchObject({ state: 'ambiguous', attributes: {} });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
