import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDashboardTarget, probeDashboard, runDashboardCommand } from '../../../src/cli/dashboard.js';
import { DashboardServer } from '../../../src/dashboard/dashboard-server.js';
import {
  DASHBOARD_ID_HEADER, DASHBOARD_ID_VALUE, DASHBOARD_INSTANCE_HEADER,
  dashboardInstanceId, resolveDashboardPort,
} from '../../../src/dashboard/dashboard-config.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
const servers: Server[] = [];
const dashboards: DashboardServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pilot-dashboard-cli-'));
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(root, 'config.json'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', '');
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(dashboards.splice(0).map(server => server.stop()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function configure(config: unknown) {
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
}

describe('Dashboard configuration', () => {
  it.each([undefined, null, 0, -1, 65536, 1.5, '9000', NaN, Infinity, {}])('defaults invalid port %s like the collector', value => {
    expect(resolveDashboardPort(value)).toBe(8765);
  });
  it.each([1, 80, 9000, 65535])('accepts configured port %s', value => {
    expect(resolveDashboardPort(value)).toBe(value);
  });
  it('reads the port every time, without caching it in the app', async () => {
    await configure({ dashboard: { port: 9000 }, dataDir: root });
    expect(await loadDashboardTarget()).toEqual({ url: 'http://127.0.0.1:9000/', port: 9000, dataDir: root });
    await configure({ dashboard: { port: 9001 }, dataDir: root });
    expect((await loadDashboardTarget()).port).toBe(9001);
  });
  it('uses the shared missing-file/default rules', async () => {
    expect(await loadDashboardTarget()).toMatchObject({ port: 8765, dataDir: path.join(homedir(), '.loongsuite-pilot') });
  });
  it('honors a custom config path, BOM, home expansion, and data-dir override', async () => {
    const custom = path.join(root, "配置 ' with spaces.json");
    await writeFile(custom, '\uFEFF' + JSON.stringify({ dataDir: '~/pilot-custom', dashboard: { port: 9010 } }));
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', custom);
    expect(await loadDashboardTarget()).toMatchObject({ port: 9010, dataDir: path.join(homedir(), 'pilot-custom') });
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
    expect((await loadDashboardTarget()).dataDir).toBe(root);
  });
  it('does not print config contents when JSON cannot be parsed', async () => {
    await writeFile(path.join(root, 'config.json'), '{"accessKeySecret":"do-not-print"');
    const stdout = vi.fn();
    expect(await runDashboardCommand(['url'], { stdout })).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith('http://127.0.0.1:8765/\n');
  });
});

describe('Dashboard identity probe', () => {
  async function listen(handler?: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return { port, dataDir: root, url: `http://127.0.0.1:${port}/` };
  }

  it('opens a real Dashboard even before the first metrics snapshot (503)', async () => {
    const assetPath = path.join(root, 'index.html');
    await writeFile(assetPath, '<!doctype html><title>Dashboard test</title>');
    const server = new DashboardServer({ dataDir: root, assetPath, port: 0 });
    dashboards.push(server);
    await server.start();
    const target = { url: server.address!, port: Number(new URL(server.address!).port), dataDir: root };
    expect(await probeDashboard(target)).toBe(true);
    expect(await probeDashboard({ ...target, dataDir: path.join(root, 'another-install') })).toBe(false);
    await mkdir(path.join(root, 'logs'));
    await writeFile(path.join(root, 'logs/metrics-summary.json'), '{"version":1}');
    expect(await probeDashboard(target)).toBe(true);
  });
  it('rejects another web service on the port', async () => {
    const target = await listen((_req, res) => res.end('not Pilot'));
    expect(await probeDashboard(target)).toBe(false);
  });
  it('never follows redirects or proxy settings', async () => {
    const requests: string[] = [];
    const target = await listen((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(302, { Location: 'http://example.invalid/',
        [DASHBOARD_ID_HEADER]: DASHBOARD_ID_VALUE,
        [DASHBOARD_INSTANCE_HEADER]: dashboardInstanceId(root) });
      res.end();
    });
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1');
    expect(await probeDashboard(target)).toBe(false);
    expect(requests).toEqual(['HEAD /metrics-summary.json']);
  });
  it('has a bounded wait for a server that never responds', async () => {
    const target = await listen(() => {});
    expect(await probeDashboard(target, 40)).toBe(false);
  });
  it('handles a refused connection', async () => {
    const target = await listen();
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
    expect(await probeDashboard(target)).toBe(false);
  });
});

describe('dashboard open command', () => {
  function dependencies() {
    return {
      platform: 'darwin' as const, language: 'en', stdout: vi.fn(), stderr: vi.fn(),
      loadTarget: vi.fn().mockResolvedValue({ port: 9000, url: 'http://127.0.0.1:9000/', dataDir: root }),
      probe: vi.fn().mockResolvedValue(true), openBrowser: vi.fn().mockResolvedValue(undefined),
    };
  }
  it('opens only the configured and verified URL', async () => {
    const deps = dependencies();
    expect(await runDashboardCommand(['open'], deps)).toBe(0);
    expect(deps.openBrowser).toHaveBeenCalledTimes(1);
    expect(deps.openBrowser).toHaveBeenCalledWith('http://127.0.0.1:9000/');
  });
  it('does not open an unavailable or mismatched Dashboard', async () => {
    const deps = dependencies();
    deps.probe.mockResolvedValue(false);
    expect(await runDashboardCommand(['open'], deps)).toBe(1);
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(deps.stderr.mock.calls[0][0]).toContain('No service was started or stopped');
  });
  it('reports browser failure without leaking child-process details', async () => {
    const deps = dependencies();
    deps.openBrowser.mockRejectedValue(new Error('secret diagnostic'));
    expect(await runDashboardCommand(['open'], deps)).toBe(1);
    expect(deps.stderr.mock.calls[0][0]).toContain('default browser');
    expect(deps.stderr.mock.calls[0][0]).not.toContain('secret diagnostic');
  });
  it('reports config failure and supports Chinese messages', async () => {
    const deps = dependencies();
    deps.language = 'zh_CN';
    deps.loadTarget.mockRejectedValue(new Error('secret config content'));
    expect(await runDashboardCommand(['open'], deps)).toBe(1);
    expect(deps.stderr.mock.calls[0][0]).toContain('配置');
    expect(deps.stderr.mock.calls[0][0]).not.toContain('secret');
  });
  it('prints URLs on other platforms without opening or probing', async () => {
    const deps = dependencies();
    expect(await runDashboardCommand(['url'], { ...deps, platform: 'linux' })).toBe(0);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(await runDashboardCommand(['open'], { ...deps, platform: 'linux' })).toBe(1);
  });
  it('validates arguments without touching installation state', async () => {
    const deps = dependencies();
    expect(await runDashboardCommand(['--help'], deps)).toBe(0);
    expect(await runDashboardCommand(['open', '--port', '9000'], deps)).toBe(2);
    expect(deps.loadTarget).not.toHaveBeenCalled();
  });
});
