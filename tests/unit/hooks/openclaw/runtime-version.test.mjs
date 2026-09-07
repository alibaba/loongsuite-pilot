import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeCapabilities } from '../../../../assets/plugins/openclaw/runtime-version.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-oc-runtime-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
function host(version = '2026.3.8', name = 'openclaw', subdir = 'dist') {
  const pkg = path.join(root, 'node_modules/openclaw');
  fs.mkdirSync(path.join(pkg, subdir), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version }));
  const entry = path.join(pkg, subdir, 'entry.mjs');
  fs.writeFileSync(entry, 'throw new Error("metadata discovery must not execute me");');
  return entry;
}

describe('OpenClaw plugin runtime version fallback', () => {
  it.each([undefined, null, '', 'unknown', ' unknown '])('resolves packaged 3.8 when runtime version is %s', version => {
    expect(resolveRuntimeCapabilities(version, host())).toMatchObject({ version: '2026.3.8', adapter: 'legacy', conversationAccess: false });
  });
  it('follows the executing symlink, not another PATH/cwd/env installation', () => {
    const entry = host();
    const link = path.join(root, 'openclaw');
    fs.symlinkSync(entry, link);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.10' }));
    vi.stubEnv('OPENCLAW_VERSION', '2026.6.10');
    vi.stubEnv('OPENCLAW_SERVICE_VERSION', '2026.6.10');
    vi.stubEnv('OPENCLAW_CLI_PATH', path.join(root, 'other-openclaw'));
    vi.stubEnv('PATH', root);
    expect(resolveRuntimeCapabilities('unknown', link)?.version).toBe('2026.3.8');
  });
  it.each(['2026.3.2', '2026.3.8-beta.1', 'not-a-version', 308])('does not override explicit unsupported runtime %s', version => {
    expect(resolveRuntimeCapabilities(version, host('2026.6.10'))).toBeNull();
  });
  it('preserves the modern runtime fast path without filesystem reads', () => {
    const realpath = vi.spyOn(fs, 'realpathSync');
    expect(resolveRuntimeCapabilities('2026.5.12', '/missing/entry')).toMatchObject({ adapter: 'modern' });
    expect(realpath).not.toHaveBeenCalled();
  });
  it.each(['2026.3.2', '2026.3.8-beta.1', 'unknown'])('rejects unsupported package metadata %s', version => {
    expect(resolveRuntimeCapabilities('unknown', host(version))).toBeNull();
  });
  it('does not escape a different named package', () => {
    const entry = host('2026.6.10', 'another-agent');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.10' }));
    expect(resolveRuntimeCapabilities('unknown', entry)).toBeNull();
  });
  it('supports nested module-scope metadata and source entry layouts', () => {
    const entry = host('2026.4.24');
    fs.writeFileSync(path.join(path.dirname(entry), 'package.json'), '{"type":"module"}');
    expect(resolveRuntimeCapabilities('unknown', entry)).toMatchObject({ adapter: 'legacy', conversationAccess: true });
    expect(resolveRuntimeCapabilities(undefined, host('2026.3.8', 'openclaw', '.'))?.version).toBe('2026.3.8');
  });
  it.each(['{', 'x'.repeat(256 * 1024 + 1)])('rejects malformed or oversized metadata (%#)', content => {
    const entry = host();
    fs.writeFileSync(path.join(root, 'node_modules/openclaw/package.json'), content);
    expect(() => resolveRuntimeCapabilities('unknown', entry)).not.toThrow();
    expect(resolveRuntimeCapabilities('unknown', entry)).toBeNull();
  });
  it('fails closed on read failures and closes opened descriptors', () => {
    const entry = host();
    vi.spyOn(fs, 'readSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    const close = vi.spyOn(fs, 'closeSync');
    expect(resolveRuntimeCapabilities('unknown', entry)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not scan indefinitely or fall back for an absent/relative entry', () => {
    expect(resolveRuntimeCapabilities('unknown', host('2026.3.8', 'openclaw', 'a/b/c/d/e/f/g/h/i'))).toBeNull();
    for (const entry of [undefined, '', 'openclaw.mjs', path.join(root, 'missing')]) {
      expect(resolveRuntimeCapabilities('unknown', entry)).toBeNull();
    }
  });
  it('re-reads changed metadata rather than retaining a stale version', () => {
    const entry = host();
    expect(resolveRuntimeCapabilities('unknown', entry)?.adapter).toBe('legacy');
    host('2026.5.12');
    expect(resolveRuntimeCapabilities('unknown', entry)?.adapter).toBe('modern');
  });
});
