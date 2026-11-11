import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireRawSourceGate } from '../../../src/utils/raw-source-gate.js';
import { appendRawJsonl } from '../../../assets/plugins/shared/raw-jsonl-writer.mjs';

let directory: string;
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
function setup() { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-gate-')); }

it('recovers immediately after a holder is killed without deleting the gate inode', () => {
  setup();
  const module = new URL('../../../assets/hooks/shared/raw-source-gate.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireRawSourceGate } from ${JSON.stringify(module)};
      acquireRawSourceGate(process.argv[1]); process.kill(process.pid, 'SIGKILL');`, directory], { timeout: 3000 });
  expect(child.signal).toBe('SIGKILL');
  const file = path.join(directory, '.raw-source-gate.sqlite');
  const inode = fs.statSync(file).ino;
  const gate = acquireRawSourceGate(directory);
  expect(gate).not.toBeNull();
  gate!.release();
  expect(fs.statSync(file).ino).toBe(inode);
});

it('shares its OS transaction lock with Python sqlite3 and releases without unlinking', () => {
  setup();
  const gate = acquireRawSourceGate(directory)!;
  const script = `import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0.025)
try:
 db.execute("BEGIN IMMEDIATE")
except sqlite3.OperationalError:
 sys.exit(7)
db.rollback()
db.close()`;
  const file = path.join(directory, '.raw-source-gate.sqlite');
  try {
    const busy = spawnSync('python3', ['-c', script, file], { timeout: 3000 });
    expect(busy.status, busy.stderr?.toString()).toBe(7);
  } finally { gate.release(); }
  const free = spawnSync('python3', ['-c', script, file], { timeout: 3000 });
  expect(free.status, free.stderr?.toString()).toBe(0);
  expect(fs.existsSync(file)).toBe(true);
});

it('bounds plugin contention to a short wait instead of blocking the Agent for 15 seconds', () => {
  setup();
  const gate = acquireRawSourceGate(directory)!;
  const file = path.join(directory, 'agent.jsonl');
  try {
    const started = performance.now();
    expect(() => appendRawJsonl(file, '{}\n')).toThrow('lock unavailable');
    expect(performance.now() - started).toBeLessThan(250);
  } finally { gate.release(); }
  appendRawJsonl(file, '{}\n');
  expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
});
