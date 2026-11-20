import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonClient } from '../../../src/interceptor/cli/daemon-client.js';
import { runHook } from '../../../src/interceptor/cli/hook.js';
import { INTERCEPTOR_SERVICE } from '../../../src/interceptor/types.js';

async function withDaemon(
  healthDelayMs: number,
  run: (port: number, evaluations: string[]) => Promise<void>,
  service: string = INTERCEPTOR_SERVICE,
): Promise<void> {
  const evaluations: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      timers.push(setTimeout(() => res.end(JSON.stringify({
        service, status: 'ok', pid: process.pid, version: 'test', daemon_port: port,
      })), healthDelayMs));
      return;
    }
    if (req.url === '/v1/hooks/evaluate') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        evaluations.push(Buffer.concat(chunks).toString('utf8'));
        res.end(JSON.stringify({ action: 'block', message: 'manual rule matched', evaluatedRules: ['manual'] }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as import('node:net').AddressInfo).port;
  try {
    await run(port, evaluations);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('interceptor daemon client', () => {
  it.each([
    { healthDelayMs: 100, shouldBlock: true },
    { healthDelayMs: 800, shouldBlock: false },
  ])('applies the default health budget to a $healthDelayMs ms response', async ({ healthDelayMs, shouldBlock }) => {
    await withDaemon(healthDelayMs, async (port, evaluations) => {
      const dir = await mkdtemp(join(tmpdir(), 'pilot-slow-health-'));
      const runtimePath = join(dir, 'runtime.json');
      try {
        await writeFile(runtimePath, JSON.stringify({
          service: INTERCEPTOR_SERVICE, status: 'ok', pid: process.pid,
          version: 'test', daemon_port: port,
        }));
        const stdout: string[] = [];
        const access: unknown[] = [];
        const code = await runHook(['--agent', 'qoder'], {
          readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'manual marker' }),
          writeStdout: text => stdout.push(text),
          log: () => undefined,
          writeAccessLog: entry => access.push(entry),
          runtimePath,
        });
        expect(code).toBe(0);
        if (shouldBlock) {
          expect(evaluations).toHaveLength(1);
          expect(JSON.parse(stdout.join(''))).toMatchObject({ decision: 'block' });
          expect(stdout.join('')).toContain('manual rule matched');
          expect(access).toEqual([]);
        } else {
          expect(evaluations).toEqual([]);
          expect(stdout).toEqual([]);
          expect(access).toEqual([expect.objectContaining({
            result: { action: 'fail-open', error: 'daemon /health: request timed out after 500ms' },
          })]);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('keeps an explicit timeout bounded and reports the failing endpoint and budget', async () => {
    await withDaemon(300, async port => {
      await expect(new DaemonClient(port).health(30)).rejects.toMatchObject({
        code: 'timeout', message: 'daemon /health: request timed out after 30ms',
      });
    });
  });

  it('continues to reject an unexpected service identity', async () => {
    await withDaemon(0, async port => {
      await expect(new DaemonClient(port).health()).rejects.toMatchObject({ code: 'invalid-response' });
    }, 'different-service');
  });
});
