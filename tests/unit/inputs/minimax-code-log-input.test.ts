import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { MinimaxCodeLogInput } from '../../../src/inputs/minimax-code-log/minimax-code-log-input.js';

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-code-log-test-'));

describe('MinimaxCodeLogInput', () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    stateStore = new StateStore(path.join(TMPDIR, 'state.json'));
    await stateStore.load();
  });

  afterEach(() => {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  });

  it('id / agentType 与 ClientType.MiniMaxCode 一致', () => {
    const input = new MinimaxCodeLogInput({ stateStore, logDir: TMPDIR });
    expect(input.id).toBe('minimax-code-log');
    expect(input.agentType).toBe('minimax-code');
  });

  it('checkAvailability 在目录不存在时返回 false', async () => {
    const elsewhere = path.join(TMPDIR, 'no-such-dir');
    const input = new MinimaxCodeLogInput({ stateStore, logDir: elsewhere });
    expect(await MinimaxCodeLogInput.checkAvailability()).toBe(false);
    expect(input.agentType).toBe('minimax-code');
  });

  it('transformRecord 接受最小可用 llm.response record', async () => {
    const input = new MinimaxCodeLogInput({ stateStore, logDir: TMPDIR });
    const record = {
      time_unix_nano: '1700000000000000000',
      'event.id': 'evt-1',
      'event.name': 'llm.response',
      'user.id': 'u1',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.provider.name': 'minimax',
      'gen_ai.request.model': 'minimax-text-01',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.response.finish_reasons': ['stop'],
    };
    const entry = await (input as any).transformRecord(record);
    expect(entry).toBeTruthy();
    expect(entry!['event.name']).toBe('llm.response');
    expect(entry!['gen_ai.agent.type']).toBe('minimax-code');
    expect(entry!['gen_ai.session.id']).toBe('sess-1');
    expect(entry!['gen_ai.usage.input_tokens']).toBe(10);
  });

  it('transformRecord 拒绝缺 event.name 的 record (返回 null)', async () => {
    const input = new MinimaxCodeLogInput({ stateStore, logDir: TMPDIR });
    const entry = await (input as any).transformRecord({
      time_unix_nano: '1700000000000000000',
      'gen_ai.session.id': 'sess-1',
    });
    expect(entry).toBeNull();
  });

  it('transformRecord 对 tool.call / tool.result 透传 tool.call.id', async () => {
    const input = new MinimaxCodeLogInput({ stateStore, logDir: TMPDIR });
    const record = {
      time_unix_nano: '1700000000000000000',
      'event.id': 'evt-tc',
      'event.name': 'tool.call',
      'user.id': 'u1',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.call.arguments': { file_path: '/etc/hosts' },
    };
    const entry = await (input as any).transformRecord(record);
    expect(entry).toBeTruthy();
    expect(entry!['event.name']).toBe('tool.call');
    expect(entry!['gen_ai.tool.name']).toBe('Read');
    expect(entry!['gen_ai.tool.call.id']).toBe('call-1');
    expect(entry!['gen_ai.tool.call.arguments']).toEqual({ file_path: '/etc/hosts' });
  });
});
