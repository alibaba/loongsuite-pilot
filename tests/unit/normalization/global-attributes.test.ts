import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseKeyValueAttributes,
  sanitizeAttributes,
  isReservedKey,
  GlobalAttributesProvider,
  DEFAULT_GIT_PASSTHROUGH_KEYS,
} from '../../../src/normalization/global-attributes.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('parseKeyValueAttributes', () => {
  it('parses OTel-style key=value,key=value', () => {
    expect(parseKeyValueAttributes('team=infra,env=prod')).toEqual({ team: 'infra', env: 'prod' });
  });
  it('keeps only the first = as separator', () => {
    expect(parseKeyValueAttributes('url=a=b')).toEqual({ url: 'a=b' });
  });
  it('trims and skips empty/malformed entries', () => {
    expect(parseKeyValueAttributes(' a = 1 , , b, =x, c=2 ')).toEqual({ a: '1', c: '2' });
  });
  it('returns empty for undefined/empty', () => {
    expect(parseKeyValueAttributes(undefined)).toEqual({});
    expect(parseKeyValueAttributes('')).toEqual({});
  });
});

describe('sanitizeAttributes', () => {
  it('drops reserved-prefix keys', () => {
    expect(sanitizeAttributes({ team: 'x', 'gen_ai.foo': 'y', 'git.repo': 'z', 'agent.o.cwd': 'w' }))
      .toEqual({ team: 'x' });
  });
  it('coerces number/boolean, skips objects/arrays', () => {
    expect(sanitizeAttributes({ a: 1, b: true, c: { x: 1 }, d: [1], e: 'ok' }))
      .toEqual({ a: '1', b: 'true', e: 'ok' });
  });
});

describe('isReservedKey', () => {
  it('flags reserved prefixes', () => {
    for (const k of ['gen_ai.x', 'git.repo', 'workspace.current_root', 'event.name', 'trace_id', 'user.id', 'cost_usd', 'agent.o.cwd']) {
      expect(isReservedKey(k)).toBe(true);
    }
  });
  it('allows plain custom keys', () => {
    expect(isReservedKey('team')).toBe(false);
    expect(isReservedKey('deployment.env')).toBe(false);
  });
});

describe('GlobalAttributesProvider', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gattr-'));
    filePath = path.join(dir, 'span-attributes.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns baseline when file is absent', () => {
    const p = new GlobalAttributesProvider({ team: 'infra' }, filePath);
    expect(p.resolve()).toEqual({ team: 'infra' });
    expect(p.keys()).toEqual(['team']);
  });

  it('file overrides baseline (config < env(baseline) < file)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ env: 'staging', extra: 'v' }));
    const p = new GlobalAttributesProvider({ team: 'infra', env: 'prod' }, filePath);
    expect(p.resolve()).toEqual({ team: 'infra', env: 'staging', extra: 'v' });
  });

  it('sanitizes file (reserved keys and non-strings dropped)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ ok: 'v', num: 3, 'git.repo': 'x', obj: { a: 1 } }));
    const p = new GlobalAttributesProvider({}, filePath);
    expect(p.resolve()).toEqual({ ok: 'v', num: '3' });
  });

  it('re-reads on mtime change (real-time file update)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ v: '1' }));
    const p = new GlobalAttributesProvider({}, filePath);
    expect(p.resolve()).toEqual({ v: '1' });
    // bump mtime forward to guarantee a change is detected
    fs.writeFileSync(filePath, JSON.stringify({ v: '2', w: '3' }));
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(filePath, future, future);
    expect(p.resolve()).toEqual({ v: '2', w: '3' });
  });

  it('falls back to baseline on bad JSON (fail-open)', () => {
    fs.writeFileSync(filePath, '{ not json');
    const p = new GlobalAttributesProvider({ team: 'infra' }, filePath);
    expect(p.resolve()).toEqual({ team: 'infra' });
  });

  it('keeps last-good and retries on bad JSON (does not drop to baseline or commit mtime)', () => {
    fs.writeFileSync(filePath, JSON.stringify({ v: '1' }));
    const p = new GlobalAttributesProvider({ team: 'infra' }, filePath);
    expect(p.resolve()).toEqual({ team: 'infra', v: '1' });

    // Simulate a concurrent/half write leaving malformed JSON (new mtime).
    fs.writeFileSync(filePath, '{ half-written');
    let future = Date.now() / 1000 + 5;
    fs.utimesSync(filePath, future, future);
    // Keeps last-good (v:1), NOT baseline — and did not commit the bad mtime.
    expect(p.resolve()).toEqual({ team: 'infra', v: '1' });

    // Once the file is valid again, the next read is picked up (retry worked).
    fs.writeFileSync(filePath, JSON.stringify({ v: '2' }));
    future = Date.now() / 1000 + 10;
    fs.utimesSync(filePath, future, future);
    expect(p.resolve()).toEqual({ team: 'infra', v: '2' });
  });

  it('resets to baseline when file is deleted', () => {
    fs.writeFileSync(filePath, JSON.stringify({ v: '1' }));
    const p = new GlobalAttributesProvider({ team: 'infra' }, filePath);
    expect(p.resolve()).toEqual({ team: 'infra', v: '1' });
    fs.rmSync(filePath);
    expect(p.resolve()).toEqual({ team: 'infra' });
  });
});

describe('DEFAULT_GIT_PASSTHROUGH_KEYS', () => {
  it('contains the git/workspace enrichment fields', () => {
    expect([...DEFAULT_GIT_PASSTHROUGH_KEYS]).toEqual([
      'git.repo',
      'git.branch',
      'git.domain',
      'workspace.current_root',
    ]);
  });
});
