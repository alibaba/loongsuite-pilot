import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardServer,
  DASHBOARD_ID_HEADER,
  DASHBOARD_ID_VALUE,
  DEFAULT_DASHBOARD_PORT,
  isAllowedDashboardHost,
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
  it('defaults to port 8765', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(8765);
  });

  it('accepts loopback Host headers without a port only on HTTP port 80', () => {
    expect(isAllowedDashboardHost('127.0.0.1', '127.0.0.1', 80)).toBe(true);
    expect(isAllowedDashboardHost('localhost', '127.0.0.1', 80)).toBe(true);
    expect(isAllowedDashboardHost('127.0.0.1', '127.0.0.1', 8765)).toBe(false);
    expect(isAllowedDashboardHost('attacker.example', '127.0.0.1', 80)).toBe(false);
  });

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
    expect(response.headers.get(DASHBOARD_ID_HEADER)).toBe(DASHBOARD_ID_VALUE);
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    const legacy = await fetch(`${server.address}api/overview`);
    expect(legacy.status).toBe(404);
  });

  it('rejects requests whose Host header is not loopback', async () => {
    const { dataDir, assetPath } = await fixture();
    const server = new DashboardServer({ dataDir, assetPath, port: 0 });
    servers.push(server);
    await server.start();
    const address = new URL(server.address!);

    const response = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: address.hostname,
        port: Number(address.port),
        path: '/metrics-summary.json',
        headers: { host: 'attacker.example' },
      }, incoming => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { body += chunk; });
        incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });

    expect(response.statusCode).toBe(421);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid dashboard host' });
  });

  it('returns 503 while metrics-summary.json is not ready', async () => {
    const { dataDir, assetPath } = await fixture();
    const server = new DashboardServer({ dataDir, assetPath, port: 0 });
    servers.push(server);
    await server.start();

    const response = await fetch(`${server.address}metrics-summary.json`);
    expect(response.status).toBe(503);
    const responseBody = await response.text();
    expect(responseBody).not.toContain(dataDir);
    expect(responseBody).not.toContain('"path"');
    const payload = JSON.parse(responseBody) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('path');
    expect(payload).toEqual({
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

  it('stops safely when closeAllConnections is unavailable', async () => {
    const { dataDir, assetPath } = await fixture();
    const server = new DashboardServer({ dataDir, assetPath, port: 0 });
    servers.push(server);
    await server.start();

    const nodeServer = (server as unknown as {
      server: { closeAllConnections?: () => void };
    }).server;
    Object.defineProperty(nodeServer, 'closeAllConnections', {
      configurable: true,
      value: undefined,
    });

    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.running).toBe(false);
  });

});
