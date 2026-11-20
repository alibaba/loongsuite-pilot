import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseHookInput } from '../../src/inputs/base/base-hook-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { LogRetentionService } from '../../src/core/log-retention-service.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';

vi.mock('../../src/utils/file-identity.js', async original => {
  const actual = await original<typeof import('../../src/utils/file-identity.js')>();
  return {
    fileIdentity: (stat: Parameters<typeof actual.fileIdentity>[0]) => actual.fileIdentity(stat, 'linux'),
    matchesFileIdentity: (saved: unknown, stat: Parameters<typeof actual.fileIdentity>[0]) => actual.matchesFileIdentity(saved, stat, 'linux'),
  };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const synthetic = (stat: Awaited<ReturnType<typeof actual.stat>>) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { birthtimeMs: stat.ctimeMs });
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => synthetic(await actual.stat(...args)),
    lstat: async (...args: Parameters<typeof actual.lstat>) => synthetic(await actual.lstat(...args)),
  };
});

class Input extends BaseHookInput {
  readonly id = 'linux-test';
  readonly agentType = ClientType.ClaudeCliHook;
  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry> {
    return { 'event.id': String(record.id) } as AgentActivityEntry;
  }
}
let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

it('reads only appended records and reclaims a consumed Linux source whose synthetic birthtime changes', async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'linux-retention-')));
  const dir = path.join(root, 'logs', 'claude-code');
  await fs.mkdir(dir, { recursive: true });
  const name = 'raw-2020-01-01.jsonl';
  const file = path.join(dir, name);
  const store = new StateStore(path.join(root, 'state.json'));
  store.set('linux-test', { lastFile: name, lastOffset: 0 });
  const ids: unknown[] = [];
  const consume = async () => {
    const input = new Input({ logDir: dir, logPrefix: 'raw', stateStore: store });
    input.on('entries', entries => ids.push(...entries.map((entry: AgentActivityEntry) => entry['event.id'])));
    await input.start(); await input.stop();
  };
  await fs.writeFile(file, '{"id":1}\n');
  await consume();
  await fs.appendFile(file, '{"id":2}\n');
  await consume();
  expect(ids).toEqual(['1', '2']);
  await fs.utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
  expect(await new LogRetentionService(root, {
    enabled: true, intervalMs: 3600000, hookHistoryDays: 7, hookErrorDays: 7,
    hookDebugDays: 7, outputDays: 7, slsFailedDays: 7, otlpFailedDays: 7, metricAlarmDays: 7,
  }, store).runCleanup()).toMatchObject({ deleted: 1, errors: 0 });
});
