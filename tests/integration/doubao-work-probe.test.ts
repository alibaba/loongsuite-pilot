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
    await build({ entryPoints: ['src/cli-probe.ts'], outfile: bundle, platform: 'node', target: 'es2022',
      bundle: true, format: 'cjs', define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' },
      banner: { js: "process.env.LOG_LEVEL='silent';" } });
    const platform = path.join(root, 'desktop-platform.cjs');
    await writeFile(platform, "Object.defineProperty(process,'platform',{value:'darwin'});");
    const scenarios = [
      { product: 'Doubao', client: undefined, expected: false },
      { product: 'Doubao', client: 'doubao', expected: true },
      { product: 'DoubaoWork', client: undefined, expected: true },
      { product: 'DoubaoWork', client: 'doubao', expected: false },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const fixtureRoot = path.join(root, `user-${index}`);
      await mkdir(path.join(fixtureRoot, 'Library', 'Application Support', scenario.product, 'sdk_storage', 'log'), { recursive: true });
      const config = path.join(fixtureRoot, 'config.json');
      await writeFile(config, JSON.stringify({ listeners: { 'doubao-work': { client: scenario.client } },
        otlpTrace: { endpoints: [null] } }));
      const { stdout } = await promisify(execFile)(process.execPath, ['--require', platform, bundle, '--config-path', config, '--installer'], {
        timeout: 10_000, env: { ...process.env, ...agentHomeEnvironment(fixtureRoot) },
      });
      const rows = JSON.parse(stdout);
      expect(rows.find((row: { id: string }) => row.id === 'doubao-work')?.detected, JSON.stringify(scenario)).toBe(scenario.expected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
