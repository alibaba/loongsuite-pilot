import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pilot-node-pin-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('service Node pins', () => {
  it.each([
    { name: 'default directory', cache: 'node', sameDirectory: true },
    { name: 'cache pin with a custom data directory', cache: 'node' },
    { name: 'data-directory pin only', data: 'node' },
    { name: 'cache pin containing spaces', cache: 'runtime with spaces/node' },
    { name: 'data pin containing spaces and Unicode', data: '运行时 with spaces/node' },
    { name: 'cache pin without a trailing newline', cache: 'node', ending: '' },
    { name: 'cache pin with CRLF', cache: 'node', ending: '\r\n' },
    { name: 'data pin with CRLF', data: 'node', ending: '\r\n' },
    { name: 'valid cache pin retains priority', cache: 'cache-node', data: 'data-node' },
    { name: 'invalid cache pin falls back to data pin', cache: 'missing', data: 'node' },
    { name: 'empty cache pin falls back to data pin', cache: '', data: 'node' },
  ])('$name', ({ cache, data, sameDirectory, ending = '\n' }) => {
    const cacheDir = join(root, 'cache');
    const dataDir = sameDirectory ? cacheDir : join(root, 'custom data');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const pins = [];
    const targets = {};
    for (const [kind, directory, value] of [['cache', cacheDir, cache], ['data', dataDir, data]]) {
      if (value === undefined) continue;
      const target = value ? join(root, kind, value) : '';
      if (value && value !== 'missing') {
        mkdirSync(join(target, '..'), { recursive: true });
        symlinkSync(process.execPath, target);
      }
      const file = join(directory, 'node-bin');
      const contents = target + ending;
      writeFileSync(file, contents);
      pins.push({ file, contents });
      targets[kind] = target;
    }
    const definitions = join(root, 'service-functions.sh');
    writeFileSync(definitions, readFileSync(resolve('scripts/loongsuite-pilot.sh'), 'utf8').split('# ---- Dispatch ----')[0]);
    const selected = execFileSync('/bin/bash', ['-c', 'source "$1"; resolve_node false', 'test', definitions], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, LOONGSUITE_PILOT_CACHE_DIR: cacheDir, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    }).trimEnd();
    expect(selected).toBe(cache && cache !== 'missing' ? targets.cache : targets.data);
    for (const { file, contents } of pins) expect(readFileSync(file, 'utf8')).toBe(contents);
  });
});
