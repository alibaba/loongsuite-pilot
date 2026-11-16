import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const loader = path.join(root, 'assets/hooks/claude-code-sdk-preload.cjs');
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-claude-sdk-preload-'));
  fs.copyFileSync(loader, path.join(tmp, 'loader.cjs'));
  fs.writeFileSync(path.join(tmp, 'claude-code-fetch-intercept.mjs'),
    `import fs from 'node:fs'; fs.appendFileSync(process.env.PILOT_TEST_MARKER, 'loaded\\n');`);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run({ executable = '/opt/claude', argv0 = executable, bun = true, env = {} } = {}) {
  const marker = path.join(tmp, 'marker');
  const script = `
    if (${JSON.stringify(bun)}) Object.defineProperty(process.versions, 'bun', { value: 'test' });
    Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(executable)} });
    require(${JSON.stringify(path.join(tmp, 'loader.cjs'))});
    process.stdout.write('business continued');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    argv0,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      PILOT_TEST_MARKER: marker,
      LOONGSUITE_PILOT_DATA_DIR: path.join(tmp, 'data'),
      AGENT_DATA_COLLECTION_CONFIG: path.join(tmp, 'config.json'),
      ...env,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('business continued');
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
}

describe('Claude SDK container preload', () => {
  test.each(['/opt/claude', '/app/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])
    ('loads the existing enrichment for a Bun Claude executable: %s', (executable) => {
      expect(run({ executable })).toBe('loaded\n');
    });

  test('accepts a Claude argv0 when the resolved executable has a versioned name', () => {
    expect(run({ executable: '/opt/claude/2.1.258', argv0: '/usr/bin/claude' })).toBe('loaded\n');
  });

  test.each(['/usr/bin/node', '/opt/pi', '/opt/dsh', '/opt/codex', '/opt/grok'])
    ('does not instrument another process: %s', (executable) => {
      expect(run({ executable })).toBe('');
    });

  test('does not instrument a non-Bun process named claude', () => {
    expect(run({ bun: false })).toBe('');
  });

  test('leaves an explicitly configured Claude preload to its existing caller', () => {
    expect(run({ env: { BUN_OPTIONS: '--require=/pilot/common.cjs --preload=/pilot/claude-code-fetch-intercept.mjs' } })).toBe('');
  });

  test.each(['none', 'openclaw,dsh', 'codex'])('respects the selected Agent list: %s', (agents) => {
    expect(run({ env: { LOONGSUITE_PILOT_AGENTS: agents } })).toBe('');
  });

  test('keeps automatic detection when the Agent list is unset or literal null', () => {
    expect(run({ env: { LOONGSUITE_PILOT_AGENTS: 'null' } })).toBe('loaded\n');
  });

  test('respects the global and Claude-specific configuration gates', () => {
    expect(run({ env: { LOONGSUITE_PILOT_ENABLED: 'false' } })).toBe('');
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agents: { 'claude-code': { enabled: false } } }));
    expect(run()).toBe('');
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ enabled: false }));
    expect(run()).toBe('');
    expect(run({ env: { LOONGSUITE_PILOT_ENABLED: ' ' } })).toBe('');
  });

  test('respects the live Agent control file', () => {
    fs.mkdirSync(path.join(tmp, 'data'));
    fs.writeFileSync(path.join(tmp, 'data', 'agent-control.json'), JSON.stringify({ tools: { 'claude-code': 'off' } }));
    expect(run()).toBe('');
  });

  test('continues business startup when configuration or enrichment is broken', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{ broken');
    expect(run()).toBe('');
    fs.unlinkSync(path.join(tmp, 'config.json'));
    fs.unlinkSync(path.join(tmp, 'claude-code-fetch-intercept.mjs'));
    expect(run()).toBe('');
  });

  test('loads the actual fetch interceptor only once across separate module URLs', () => {
    const source = path.join(root, 'assets/hooks/claude-code-fetch-intercept.mjs');
    const script = `
      globalThis.require = require;
      const original = globalThis.fetch;
      require(${JSON.stringify(source)});
      const first = globalThis.fetch;
      import(${JSON.stringify('file://' + source + '?second-load')}).then(() => {
        process.stdout.write(first !== original && globalThis.fetch === first ? 'once' : 'unexpected');
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('once');
  });
});
