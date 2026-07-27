import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '../../../assets/hooks');
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeFixture(qodercliSource, withIntercept = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-qoder-wrapper-'));
  tempDirs.push(root);
  const hooks = path.join(root, 'hooks');
  const bin = path.join(root, 'bin');
  await fs.mkdir(hooks, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.copyFile(
    path.join(ASSETS, 'qodercli-runtime-wrapper.sh'),
    path.join(hooks, 'qodercli-runtime-wrapper.sh'),
  );
  if (withIntercept) {
    await fs.writeFile(path.join(hooks, 'qodercli-token-intercept.mjs'), 'export {};\n');
  }
  const qodercli = path.join(bin, 'qodercli');
  await fs.writeFile(qodercli, qodercliSource, { mode: 0o755 });
  return {
    root,
    wrapper: path.join(hooks, 'qodercli-runtime-wrapper.sh'),
    bin,
  };
}

describe('qodercli runtime wrapper', () => {
  it('uses NODE_OPTIONS --import for a Node shebang and preserves user options', async () => {
    const fixture = await makeFixture(`#!/usr/bin/env node
console.log(JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  bunOptions: process.env.BUN_OPTIONS || '',
  args: process.argv.slice(2)
}));
`);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '--trace-warnings',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toContain('--import=');
    expect(output.nodeOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.nodeOptions).toContain('--trace-warnings');
    expect(output.bunOptions).toBe('');
    expect(output.args).toEqual(['hello']);
  });

  it('uses BUN_OPTIONS --preload for a native/non-Node launcher', async () => {
    const fixture = await makeFixture(`#!/bin/sh
printf '{"nodeOptions":"%s","bunOptions":"%s","arg":"%s"}\\n' "$NODE_OPTIONS" "$BUN_OPTIONS" "$1"
`);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '--preload=/user/own.mjs',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toBe('');
    expect(output.bunOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.bunOptions).toContain('/user/own.mjs');
    expect(output.arg).toBe('hello');
  });

  it('fails open when the intercept asset is missing', async () => {
    const fixture = await makeFixture(`#!/bin/sh
printf 'QODER_OK:%s\\n' "$1"
`, false);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('QODER_OK:hello');
  });
});
