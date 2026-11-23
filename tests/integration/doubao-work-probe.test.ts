import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { agentHomeEnvironment } from '../helpers/isolated-agent-home.js';

it('the installer probe reads the configured Doubao product from --config-path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-probe-bundle-'));
  try {
    const bundle = path.join(root, 'dist', 'cli-probe.cjs');
    await mkdir(path.join(root, 'agents.d'));
    await writeFile(path.join(root, 'agents.d', 'doubao-work.json'), await readFile(path.resolve('agents.d/doubao-work.json')));
    await writeFile(path.join(root, 'agents.d', 'doubao.json'), await readFile(path.resolve('agents.d/doubao.json')));
    await build({ entryPoints: ['src/cli-probe.ts'], outfile: bundle, platform: 'node', target: 'es2022',
      bundle: true, format: 'cjs', define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' },
      banner: { js: "process.env.LOG_LEVEL='silent';" } });
    const platform = path.join(root, 'desktop-platform.cjs');
    await writeFile(platform, "Object.defineProperty(process,'platform',{value:'darwin'});");
    const scenarios = [
      { products: ['Doubao'], client: undefined, work: false, app: true },
      { products: ['Doubao'], client: 'doubao', work: true, app: undefined },
      { products: ['DoubaoWork'], client: undefined, work: true, app: false },
      { products: ['DoubaoWork'], client: 'doubao', work: false, app: undefined },
      { products: ['Doubao', 'DoubaoWork'], client: undefined, work: true, app: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const fixtureRoot = path.join(root, `user-${index}`);
      for (const product of scenario.products) {
        await mkdir(path.join(fixtureRoot, 'Library', 'Application Support', product, 'sdk_storage', 'log'), { recursive: true });
      }
      const config = path.join(fixtureRoot, 'config.json');
      await writeFile(config, JSON.stringify({ listeners: { 'doubao-work': { client: scenario.client } },
        otlpTrace: { endpoints: [null] } }));
      const { stdout } = await promisify(execFile)(process.execPath, ['--require', platform, bundle, '--config-path', config, '--installer'], {
        timeout: 10_000, env: { ...process.env, ...agentHomeEnvironment(fixtureRoot) },
      });
      const rows = JSON.parse(stdout);
      expect(rows.find((row: { id: string }) => row.id === 'doubao-work')?.detected, JSON.stringify(scenario)).toBe(scenario.work);
      expect(rows.find((row: { id: string }) => row.id === 'doubao')?.detected, JSON.stringify(scenario)).toBe(scenario.app);
      if (scenario.client === 'doubao') {
        const listed = await promisify(execFile)(process.execPath, ['--require', platform, bundle, '--config-path', config, '--list', '--installer'], {
          timeout: 10_000, env: { ...process.env, ...agentHomeEnvironment(fixtureRoot) },
        });
        expect(JSON.parse(listed.stdout).map((row: { id: string }) => row.id).sort()).toEqual(['doubao', 'doubao-work']);
      }
    }
    const config = path.join(root, 'disabled-config.json');
    await writeFile(config, JSON.stringify({ listeners: { doubao: { enabled: false, client: 'invalid' } } }));
    const listed = await promisify(execFile)(process.execPath, ['--require', platform, bundle, '--config-path', config, '--list', '--installer'], {
      timeout: 10_000, env: { ...process.env, ...agentHomeEnvironment(root) },
    });
    expect(JSON.parse(listed.stdout).map((row: { id: string }) => row.id).sort()).toEqual(['doubao', 'doubao-work']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
