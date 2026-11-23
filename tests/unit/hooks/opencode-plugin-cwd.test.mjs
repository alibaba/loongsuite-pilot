import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../assets/plugins/opencode/plugin.mjs',
);

let tmpDir;
let prevDataDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cwd-'));
  prevDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  process.env.LOONGSUITE_PILOT_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  else process.env.LOONGSUITE_PILOT_DATA_DIR = prevDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPlugin() {
  const mod = await import(`${pathToFileURL(PLUGIN_PATH).href}?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

async function firstRecord(serverInput) {
  const plugin = await loadPlugin();
  const hooks = await plugin.server(serverInput, {});
  await hooks['chat.message'](
    { sessionID: 'ses_cwd' },
    { message: {}, parts: [{ type: 'text', text: 'hi' }] },
  );
  const dir = path.join(tmpDir, 'logs', 'opencode');
  const lines = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return lines[0];
}

describe('opencode plugin cwd capture', () => {
  it('emits agent.opencode.cwd from the server input directory', async () => {
    const rec = await firstRecord({ directory: '/tmp/fake-repo' });
    expect(rec['agent.opencode.cwd']).toBe('/tmp/fake-repo');
  });

  it('falls back to process.cwd() when directory is absent', async () => {
    const rec = await firstRecord({});
    expect(rec['agent.opencode.cwd']).toBe(process.cwd());
  });
});
