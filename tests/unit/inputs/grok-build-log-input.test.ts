import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { GrokBuildLogInput } from '../../../src/inputs/grok-build-log/grok-build-log-input.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('GrokBuildLogInput', () => {
  let dir: string;
  let input: GrokBuildLogInput;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-input-'));
    const state = new MockStateStore();
    state.set('grok-build-log', { lastFile: `grok-build-${today()}.jsonl`, lastOffset: 0 });
    input = new GrokBuildLogInput({
      stateStore: state as never,
      logDir: dir,
      logPrefix: 'grok-build',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('registers as a Grok hook JSONL input and preserves reconstruction fields', async () => {
    expect(input.id).toBe('grok-build-log');
    expect(input.agentType).toBe(ClientType.GrokBuildHook);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);

    await fs.writeFile(path.join(dir, `grok-build-${today()}.jsonl`), `${JSON.stringify({
      time_unix_nano: '1785296938000000000',
      'event.id': 'grok-tool-result',
      'event.name': 'tool.result',
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'prompt-1',
      'gen_ai.agent.type': 'grok-build',
      'gen_ai.tool.name': 'read_file',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.call.duration': 125,
      'tool.result.status': 'failure',
      'loongsuite.grok.match.strategy': 'id',
      'loongsuite.grok.timing.source': 'unified',
    })}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'gen_ai.agent.type': 'grok-build',
      'gen_ai.tool.call.duration': 125,
      'tool.result.status': 'failure',
      'loongsuite.grok.match.strategy': 'id',
      'loongsuite.grok.timing.source': 'unified',
    });
  });
});
