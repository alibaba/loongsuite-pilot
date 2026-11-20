import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MimoCodeLogInput } from '../../../src/inputs/mimo-code-log/mimo-code-log-input.js';
import { ClientType, type AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('MimoCodeLogInput', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mimo-code-input-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('normalizes plugin cwd into canonical workspace and Git fields', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await fs.writeFile(path.join(tmpDir, `mimo-code-${date}.jsonl`), `${JSON.stringify({
      time_unix_nano: '1784188800000000000',
      'event.id': 'mimo-event-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'mimo-session-1',
      'gen_ai.agent.type': ClientType.MimoCode,
      'agent.mimo-code.cwd': tmpDir,
    })}\n`);

    const input = new MimoCodeLogInput({
      stateStore: new MockStateStore() as never,
      logDir: tmpDir,
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'mimo-event-1',
      'gen_ai.agent.type': ClientType.MimoCode,
      'agent.mimo-code.cwd': tmpDir,
      'workspace.path': tmpDir,
    });
  });
});
