import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntime,
  removeOwnPid,
  writePid,
  writeRuntime,
} from '../../../src/interceptor/daemon/runtime.js';
import { interceptorRuntimePath } from '../../../src/interceptor/paths.js';
import { readProcessStartToken } from '../../../src/utils/pid-utils.js';

vi.mock('../../../src/utils/pid-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/pid-utils.js')>(),
  readProcessStartToken: vi.fn(() => {
    throw new Error('runtime heartbeats must not query process identity');
  }),
}));

describe('interceptor runtime files', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds runtime metadata without querying the process lifetime token', () => {
    const runtime = buildRuntime({ port: 18791, version: '1.2.3', gitCommit: 'abc123' });

    expect(runtime).toMatchObject({
      service: 'loongsuite-pilot-interceptor', status: 'ok', pid: process.pid,
      version: '1.2.3', packageVersion: '1.2.3', gitCommit: 'abc123', daemon_port: 18791,
    });
    expect(runtime).not.toHaveProperty('processStartToken');
    expect(Number.isNaN(Date.parse(runtime.updatedAt))).toBe(false);
    expect(readProcessStartToken).not.toHaveBeenCalled();
  });

  it('refreshes heartbeats and drops a legacy token without querying process identity', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-heartbeat-'));
    const file = interceptorRuntimePath(dataDir);
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ processStartToken: 'legacy-token', updatedAt: '2000-01-01T00:00:00Z' }));

      const opts = { dataDir, port: 18791, version: '1.2.3' };
      await writeRuntime(opts);
      const runtime = await writeRuntime(opts);

      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(runtime);
      expect(runtime).not.toHaveProperty('processStartToken');
      expect(Date.parse(runtime.updatedAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00Z'));
      expect(readProcessStartToken).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not remove a PID file already replaced by a successor', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-runtime-'));
    const pidFile = join(dataDir, 'interceptor', 'interceptor.pid');
    writePid(dataDir);
    await writeFile(pidFile, `${process.pid + 1}\n`);

    removeOwnPid(dataDir);

    expect(existsSync(pidFile)).toBe(true);
    await expect(readFile(pidFile, 'utf8')).resolves.toBe(`${process.pid + 1}\n`);
  });
});
