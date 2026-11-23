import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { commandExists } from '../../../src/deployment/detect-utils.js';

it('rechecks command detection when the lookup PATH changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-path-'));
  const bin = path.join(root, 'bin');
  const command = `pilot-path-fixture-${process.pid}`;
  const previousPath = process.env.PATH;
  try {
    expect(await commandExists(command)).toBe(false);
    await mkdir(bin);
    await writeFile(path.join(bin, command + (process.platform === 'win32' ? '.cmd' : '')),
      process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    expect(await commandExists(command)).toBe(true);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    expect(await commandExists(command)).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
