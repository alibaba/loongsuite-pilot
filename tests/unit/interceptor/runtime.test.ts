import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntime,
  removeOwnPid,
  writePid,
} from '../../../src/interceptor/daemon/runtime.js';

describe('interceptor runtime files', () => {
  it('records the process lifetime token when the platform exposes one', () => {
    const runtime = buildRuntime({ port: 18791, version: '1.2.3' });

    if (runtime.processStartToken !== undefined) {
      expect(runtime.processStartToken.length).toBeGreaterThan(0);
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
