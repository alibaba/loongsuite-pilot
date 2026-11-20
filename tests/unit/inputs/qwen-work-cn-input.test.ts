import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { ClientType } from '../../../src/types/index.js';
import { QwenWorkCNInput } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QwenWorkCNInput', () => {
  let dir: string;
  let input: QwenWorkCNInput;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-work-cn-hook-'));
    input = new QwenWorkCNInput({
      stateStore: new MockStateStore() as never,
      logDir: dir,
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('has a product-specific identity', () => {
    expect(input.id).toBe('qwen-work-cn-hook');
    expect(input.agentType).toBe(ClientType.QwenWorkCN);
  });

  it('reads canonical hook output and enforces the QwenWorkCN agent type', async () => {
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    await fs.writeFile(path.join(dir, `qwen-work-cn-${day}.jsonl`), `${JSON.stringify({
      'event.id': 'qwen-event-1',
      'event.name': 'llm.request',
      'gen_ai.agent.type': 'unexpected',
      'gen_ai.session.id': 'qwen-session-1',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }],
      time_unix_nano: '1770000000000000000',
      observed_time_unix_nano: '1770000000000000000',
      version: '0.1.5',
      'agent.qwenworkcn.version': '0.1.5',
      'agent.qwenworkcn.cwd': '/workspace/qwen-work-cn',
    })}\n`);
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!['gen_ai.agent.type']).toBe(ClientType.QwenWorkCN);
    expect(entries[0]!['gen_ai.session.id']).toBe('qwen-session-1');
    expect(entries[0]!['workspace.path']).toBe('/workspace/qwen-work-cn');
    expect(entries[0]!.version).toBeUndefined();
    expect(entries[0]!['agent.qwenworkcn.version']).toBe('0.1.5');
    expect(input.getAgentVersion()).toBe('0.1.5');
  });
});
