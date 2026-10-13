import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse as parseToml } from 'smol-toml';
import { cleanupCodexHooks, planCodexHookCleanup } from '../../../src/deployment/codex-hook-cleanup.js';
import { remapCodexTrust } from '../../../src/deployment/codex-trust-writer.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const pilot = { type: 'command', command: 'node "/custom data/hooks/codex-loongsuite-pilot-hook.mjs" stop' };
const third = (name: string) => ({ type: 'command', command: `/third-party/${name}` });
const group = (...hooks: unknown[]) => ({ hooks });
const hookPath = '/fixture/.codex/hooks.json';
const key = (g: number, h = 0, file = hookPath) => `${file}:stop:${g}:${h}`;
const section = (k: string, hash: string, enabled = true) =>
  `[hooks.state.${JSON.stringify(k)}]\ntrusted_hash = "${hash}"\nenabled = ${enabled}\n`;
const state = (content: string) => (parseToml(content).hooks as any)?.state ?? {};
const roots: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Codex cleanup migrates existing positional trust', () => {
  it('moves later groups and same-group handlers without granting trust', () => {
    const original = { hooks: { Stop: [group(pilot), group(third('a'), pilot, third('b')), group(pilot), group(third('c'))] } };
    const plan = planCodexHookCleanup(original, hookPath);
    const unrelated = '# user settings\nmodel = "unchanged"\n';
    const config = unrelated + section(key(0), 'pilot') + section(key(1), 'a')
      + section(key(1, 1), 'pilot2') + section(key(1, 2), 'modified-old-hash', false)
      + section(key(2), 'pilot3') + section(key(3), 'c')
      + section('/other/hooks.json:stop:0:0', 'other');
    const result = remapCodexTrust(config, plan.moves);
    expect(plan.data).toEqual({ hooks: { Stop: [group(third('a'), third('b')), group(third('c'))] } });
    expect(original.hooks.Stop).toHaveLength(4);
    expect(result.startsWith(unrelated)).toBe(true);
    expect(state(result)).toEqual({
      [key(0)]: { trusted_hash: 'a', enabled: true },
      [key(0, 1)]: { trusted_hash: 'modified-old-hash', enabled: false },
      [key(1)]: { trusted_hash: 'c', enabled: true },
      ['/other/hooks.json:stop:0:0']: { trusted_hash: 'other', enabled: true },
    });
  });

  it('does not leave the removed Pilot trust on a previously untrusted successor', () => {
    const plan = planCodexHookCleanup({ hooks: { Stop: [group(pilot), group(third('untrusted'))] } }, hookPath);
    expect(state(remapCodexTrust(section(key(0), 'pilot'), plan.moves))).toEqual({});
  });

  it('keeps earlier trust byte-for-byte when Pilot is last', () => {
    const plan = planCodexHookCleanup({ hooks: { Stop: [group(third('a')), group(pilot)] } }, hookPath);
    const first = section(key(0), 'a', false);
    expect(remapCodexTrust(first + section(key(1), 'pilot'), plan.moves)).toBe(first);
  });

  it('handles direct handlers and removes an event only when emptied', () => {
    const plan = planCodexHookCleanup({ hooks: { Stop: [pilot, third('a')], SessionStart: [group(pilot)] } }, hookPath);
    expect(plan.data).toEqual({ hooks: { Stop: [third('a')] } });
    expect(state(remapCodexTrust(section(key(0), 'pilot') + section(key(1), 'a'), plan.moves)))
      .toEqual({ [key(0)]: { trusted_hash: 'a', enabled: true } });
  });

  it('preserves legacy OTel hooks and unrelated entries', () => {
    const data = { hooks: { Stop: [null, group(), group({ command: 'otel-codex-hook stop' }), { command: 'echo hook-entry.sh' }] } };
    expect(planCodexHookCleanup(data, hookPath)).toMatchObject({ data, changed: false });
  });

  it('handles escaped Windows paths, CRLF and literal TOML keys', () => {
    const win = 'C:\\Users\\test\\.codex\\hooks.json';
    const plan = planCodexHookCleanup({ hooks: { Stop: [group(pilot), group(third('a'))] } }, win);
    const config = `[hooks.state.'${key(1, 0, win)}']\r\ntrusted_hash = "a"\r\nenabled = false\r\n`;
    expect(state(remapCodexTrust(config, plan.moves))).toEqual({ [key(0, 0, win)]: { trusted_hash: 'a', enabled: false } });
  });

  it('rejects mixed command/commandWindows ownership', () => {
    expect(() => planCodexHookCleanup({ hooks: { Stop: [group({ ...pilot, commandWindows: 'third-party' })] } }, hookPath))
      .toThrow('Mixed ownership');
  });

  function fixture(config?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-codex-cleanup-'));
    roots.push(root);
    const hooks = path.join(root, 'hooks.json');
    const toml = path.join(root, 'config.toml');
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [group(pilot), group(third('a'))] } }));
    if (config !== undefined) fs.writeFileSync(toml, config);
    return { hooks, toml };
  }

  it('is idempotent with a missing trust file', () => {
    const { hooks, toml } = fixture();
    expect(cleanupCodexHooks(hooks, toml)).toBe(true);
    expect(cleanupCodexHooks(hooks, toml)).toBe(false);
    expect(fs.existsSync(toml)).toBe(false);
  });

  it('writes both files and preserves disabled state across repeated cleanup', () => {
    const { hooks, toml } = fixture();
    fs.writeFileSync(toml, section(key(0, 0, hooks), 'pilot') + section(key(1, 0, hooks), 'a', false));
    expect(cleanupCodexHooks(hooks, toml)).toBe(true);
    expect(state(fs.readFileSync(toml, 'utf8'))).toEqual({ [key(0, 0, hooks)]: { trusted_hash: 'a', enabled: false } });
    expect(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.Stop).toEqual([group(third('a'))]);
    expect(cleanupCodexHooks(hooks, toml)).toBe(false);
  });

  it('runs the self-contained uninstall artifact outside the package without node_modules', async () => {
    const { hooks, toml } = fixture();
    const bundle = path.join(path.dirname(hooks), 'cleanup.cjs');
    await build({ entryPoints: ['src/cli/codex-hook-cleanup.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'es2022' });
    fs.writeFileSync(toml, section(key(0, 0, hooks), 'pilot') + section(key(1, 0, hooks), 'a', false));
    execFileSync(process.execPath, [bundle, hooks, toml], { cwd: path.dirname(bundle) });
    expect(state(fs.readFileSync(toml, 'utf8'))).toEqual({ [key(0, 0, hooks)]: { trusted_hash: 'a', enabled: false } });
    expect(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.Stop).toEqual([group(third('a'))]);
  });

  it.each(['bad = [', '[hooks.state]\n"KEY" = { trusted_hash = "a" }\n'])('fails before either write for unsupported/invalid config', config => {
    const { hooks, toml } = fixture();
    fs.writeFileSync(toml, config.replace('KEY', key(1, 0, hooks)));
    const beforeHooks = fs.readFileSync(hooks, 'utf8');
    const beforeToml = fs.readFileSync(toml, 'utf8');
    expect(() => cleanupCodexHooks(hooks, toml)).toThrow();
    expect(fs.readFileSync(hooks, 'utf8')).toBe(beforeHooks);
    expect(fs.readFileSync(toml, 'utf8')).toBe(beforeToml);
  });

  it('rolls back trust when the hooks rename fails', () => {
    const { hooks, toml } = fixture();
    const before = section(key(0, 0, hooks), 'pilot') + section(key(1, 0, hooks), 'a', false);
    fs.writeFileSync(toml, before);
    const rename = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (to === fs.realpathSync(hooks)) throw new Error('injected write failure');
      rename(from, to);
    });
    expect(() => cleanupCodexHooks(hooks, toml)).toThrow('injected');
    expect(fs.readFileSync(toml, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.Stop).toHaveLength(2);
  });
});
