import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startInterceptorService } from '../../../src/interceptor/daemon/lifecycle.js';
import { interceptorRuntimePath } from '../../../src/interceptor/paths.js';

describe('embedded interceptor service', () => {
  it('listens, writes runtime for this process, and releases the port on stop', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-embedded-'));
    const service = await startInterceptorService({
      dataDir,
      version: '9.9.9',
      gitCommit: 'abc123',
    });

    try {
      const runtime = JSON.parse(await readFile(interceptorRuntimePath(dataDir), 'utf8')) as {
        pid: number;
        status: string;
        packageVersion: string;
        gitCommit: string;
        daemon_port: number;
      };
      expect(runtime).toMatchObject({
        status: 'ok',
        pid: process.pid,
        packageVersion: '9.9.9',
        gitCommit: 'abc123',
        daemon_port: service.port,
      });

      const health = await fetch(`http://127.0.0.1:${service.port}/health`);
      await expect(health.json()).resolves.toMatchObject({
        status: 'ok',
        pid: process.pid,
        daemon_port: service.port,
      });
    } finally {
      await service.stop();
    }

    await expect(fetch(`http://127.0.0.1:${service.port}/health`)).rejects.toThrow();
  });
});
