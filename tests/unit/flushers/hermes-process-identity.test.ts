import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivityEntry } from '../../../src/types/index.js';

const io = vi.hoisted(() => ({ readFile: vi.fn(), readlink: vi.fn() }));
vi.mock('node:fs/promises', () => io);
import { currentHermesProcessNamespace, hermesProcessIdentity, isHermesProcessDead } from '../../../src/flushers/hermes-process-identity.js';

const owner = { pid: 123, startTicks: '456', pidNamespace: 'pid:[1234]',
  bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sourceToken: ['123', '456', 'abcdef12'].join('-') };
const current = { pidNamespace: owner.pidNamespace, bootId: owner.bootId };

function stat(state: string, start: string) {
  // /proc/<pid>/stat fields 3 through 22, after a command containing ')'.
  return `123 (test) name) ${[state, ...Array(18).fill('0'), start].join(' ')}`;
}

afterEach(() => { vi.restoreAllMocks(); io.readFile.mockReset(); io.readlink.mockReset(); });

describe('Hermes process identity', () => {
  it.runIf(process.platform === 'linux')('uses self-owned procfs metadata without requiring access to /proc/1', async () => {
    io.readlink.mockImplementation(async (file: string) =>
      file === '/proc/self/ns/pid' ? owner.pidNamespace : String(process.pid));
    io.readFile.mockImplementation(async (file: string) =>
      file === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : owner.bootId);
    expect(await currentHermesProcessNamespace()).toEqual(current);
    expect(io.readlink).not.toHaveBeenCalledWith('/proc/1/ns/pid');
  });

  it.runIf(process.platform === 'linux')('rejects parent-mounted procfs and absent or mismatched PID evidence', async () => {
    io.readlink.mockImplementation(async (file: string) =>
      file === '/proc/self/ns/pid' ? owner.pidNamespace : String(process.pid));
    for (const status of [`NSpid:\t999\t${process.pid}\n`, 'Name:\tnode\n', `NSpid:\t${process.pid + 1}\n`]) {
      io.readFile.mockImplementation(async (file: string) =>
        file === '/proc/self/status' ? status : owner.bootId);
      expect(await currentHermesProcessNamespace()).toBeUndefined();
    }
    io.readlink.mockImplementation(async (file: string) =>
      file === '/proc/self/ns/pid' ? owner.pidNamespace : String(process.pid + 1));
    io.readFile.mockImplementation(async (file: string) =>
      file === '/proc/self/status' ? `NSpid:\t${process.pid}\n` : owner.bootId);
    expect(await currentHermesProcessNamespace()).toBeUndefined();
  });

  it('requires complete, bounded identity fields', () => {
    const value = { pid: 123, start_ticks: '456', pid_namespace: owner.pidNamespace,
      boot_id: owner.bootId, source_token: owner.sourceToken };
    const row = { 'agent.hermes.process': value } as AgentActivityEntry;
    expect(hermesProcessIdentity(row)).toEqual(owner);
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, pid: -1 } })).toBeUndefined();
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, start_ticks: '../123' } })).toBeUndefined();
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, pid_namespace: 'unknown' } })).toBeUndefined();
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, boot_id: '' } })).toBeUndefined();
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, source_token: '../bad' } })).toBeUndefined();
    expect(hermesProcessIdentity({ ...row, 'agent.hermes.process': { ...value, source_token: '124-456-abcdef12' } })).toBeUndefined();
  });

  it('never declares a different namespace or boot dead', async () => {
    expect(await isHermesProcessDead(owner, { ...current, pidNamespace: 'pid:[42]' })).toBe(false);
    expect(await isHermesProcessDead(owner, { ...current, bootId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).toBe(false);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it('distinguishes a live owner, zombie, reused PID, and malformed stat', async () => {
    io.readFile.mockResolvedValueOnce(stat('S', '456')).mockResolvedValueOnce(stat('Z', '456'))
      .mockResolvedValueOnce(stat('S', '789')).mockResolvedValueOnce('invalid');
    expect(await isHermesProcessDead(owner, current)).toBe(false);
    expect(await isHermesProcessDead(owner, current)).toBe(true);
    expect(await isHermesProcessDead(owner, current)).toBe(true);
    expect(await isHermesProcessDead(owner, current)).toBe(false);
  });

  it('requires kernel ESRCH when proc is missing and treats permission errors as unknown', async () => {
    io.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => true)
      .mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(await isHermesProcessDead(owner, current)).toBe(false);
    expect(await isHermesProcessDead(owner, current)).toBe(false);
    expect(await isHermesProcessDead(owner, current)).toBe(true);
  });
});
