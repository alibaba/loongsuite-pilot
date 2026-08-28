// Explicit opt-in: this test opens two harmless local fixture pages in the
// user's default browser. Never run it implicitly in CI or the general suite.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { installDashboardApp, uninstallDashboardApp } from '../../scripts/manage-dashboard-app.mjs';

const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin' || process.env.PILOT_DASHBOARD_NATIVE_E2E !== '1')('native Dashboard app', () => {
  it('opens through LaunchServices, rereads a changed port, and leaves collection untouched', async () => {
    const bundle = resolve('dist/dashboard-cli.cjs');
    expect(existsSync(bundle), 'run npm run build first').toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'pilot-dashboard-native-'));
    const cacheDir = join(root, 'cache');
    const dataDir = join(root, "用户 数据 ' quoted");
    const configPath = join(dataDir, 'config.json');
    const commandPath = join(root, 'bin/loongsuite-pilot');
    const dist = join(cacheDir, 'versions/fixture/dist');
    const servers = [];
    const requests = [];
    try {
      mkdirSync(dist, { recursive: true });
      mkdirSync(dataDir);
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(cacheDir, 'current'), 'fixture');
      // Mirrors --data-dir installs: the pin lives next to the custom config.
      writeFileSync(join(dataDir, 'node-bin'), process.execPath);
      copyFileSync(bundle, join(dist, 'dashboard-cli.cjs'));
      copyFileSync(resolve('scripts/loongsuite-pilot.sh'), commandPath);
      const instanceId = createHash('sha256').update(resolve(dataDir)).digest('hex');
      for (let i = 0; i < 2; i++) {
        const server = createServer((req, res) => {
          requests.push({ index: i, method: req.method, url: req.url });
          res.setHeader('x-loongsuite-pilot-dashboard', 'metrics-summary-v1');
          res.setHeader('x-loongsuite-pilot-instance', instanceId);
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(`<!doctype html><title>Pilot launcher verification ${i + 1}</title><p>Local launcher verification succeeded. This page contains no Pilot data.</p>`);
        });
        await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
        servers.push(server);
      }
      const options = { configPath, cacheDir, commandPath, applicationsDir: join(root, 'Applications') };
      const { appPath } = installDashboardApp(options);
      // No node_modules exists anywhere in the fake installation.
      expect(existsSync(join(cacheDir, 'node_modules'))).toBe(false);
      for (let i = 0; i < 2; i++) {
        const port = servers[i].address().port;
        writeFileSync(configPath, JSON.stringify({ dataDir, dashboard: { port } }));
        const before = readFileSync(configPath, 'utf8');
        const printed = await exec('/bin/bash', [commandPath, 'dashboard', 'url'], { env: {
          ...process.env, PATH: '/usr/bin:/bin', AGENT_DATA_COLLECTION_CONFIG: configPath,
          LOONGSUITE_PILOT_CACHE_DIR: cacheDir, LOONGSUITE_PILOT_DATA_DIR: '',
        } });
        expect(printed.stdout.trim()).toBe(`http://127.0.0.1:${port}/`);
        await exec('/usr/bin/open', ['-W', appPath], { timeout: 15_000 });
        await vi.waitFor(() => {
          expect(requests).toContainEqual({ index: i, method: 'HEAD', url: '/metrics-summary.json' });
          expect(requests).toContainEqual({ index: i, method: 'GET', url: '/' });
        }, { timeout: 10_000 });
        expect(readFileSync(configPath, 'utf8')).toBe(before);
        execFileSync('/usr/bin/codesign', ['--verify', '--strict', appPath]);
      }
      expect(existsSync(join(dataDir, 'logs'))).toBe(false);
      expect(existsSync(join(dataDir, 'collector.lock'))).toBe(false);
      expect(existsSync(join(dataDir, 'loongsuite-pilot.pid'))).toBe(false);
      expect(uninstallDashboardApp(options).status).toBe('removed');
      expect(existsSync(configPath)).toBe(true);
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolveClose => server.close(resolveClose));
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
