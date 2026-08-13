import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardServer,
} from '../../../src/dashboard/dashboard-server.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const servers: DashboardServer[] = [];
const tempDirs: string[] = [];

async function fixture(): Promise<{ dataDir: string; assetPath: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pilot-dashboard-'));
  tempDirs.push(dataDir);
  const assetPath = path.join(dataDir, 'index.html');
  await writeFile(assetPath, '<!doctype html><title>dashboard fixture</title>');
  return { dataDir, assetPath };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('DashboardServer', () => {
  it('serves only the static page and the unmodified summary file', async () => {
    const { dataDir, assetPath } = await fixture();
    const summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
    const summary = '{"version":1,"ranges":{"today":{"agentShares":[{"agentType":"future-agent"}]}}}';
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, summary);

    const server = new DashboardServer({ dataDir, assetPath, port: 0 });
    servers.push(server);
    await server.start();

    const page = await fetch(server.address!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('dashboard fixture');

    const response = await fetch(`${server.address}metrics-summary.json`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(summary);

    const legacy = await fetch(`${server.address}api/overview`);
    expect(legacy.status).toBe(404);
  });

  it('returns 503 while metrics-summary.json is not ready', async () => {
    const { dataDir, assetPath } = await fixture();
    const server = new DashboardServer({ dataDir, assetPath, port: 0 });
    servers.push(server);
    await server.start();

    const response = await fetch(`${server.address}metrics-summary.json`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'metrics summary is not ready',
    });
  });

  it('treats an occupied port as non-fatal', async () => {
    const { dataDir, assetPath } = await fixture();
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('missing blocker port');

    const server = new DashboardServer({ dataDir, assetPath, port: address.port });
    await expect(server.start()).resolves.toBeUndefined();
    expect(server.running).toBe(false);
    await new Promise<void>(resolve => blocker.close(() => resolve()));
  });

});
