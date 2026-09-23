// Node 20.20.2 used to pass a version short-circuit and be selected as the
// collector runtime. Suitability is require('node:sqlite'), which that Node
// fails and Node 22.23.2 passes.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve('.');

function extractFn(src, name) {
  const start = src.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function ps1Fn(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end);
}

const installerSh = readFileSync(resolve(REPO, 'deploy/installer-opensource.sh'), 'utf8');
const serviceSh = readFileSync(resolve(REPO, 'scripts/loongsuite-pilot.sh'), 'utf8');
const installerPs1 = readFileSync(resolve(REPO, 'deploy/installer-opensource.ps1'), 'utf8');
const servicePs1 = readFileSync(resolve(REPO, 'scripts/loongsuite-pilot.ps1'), 'utf8');

const tmp = mkdtempSync(join(tmpdir(), 'node-sqlite-req-'));

function writeFakeNode() {
  const bin = join(tmp, `node-${process.hrtime.bigint()}`);
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "$FAKE_NODE_VERSION"
  exit 0
fi
if [ "$1" = "-e" ]; then
  case "$2" in
    *node:sqlite*) exit "$FAKE_SQLITE_EXIT" ;;
  esac
fi
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}

function suitable(scriptSrc, bin, env) {
  const body = [
    extractFn(scriptSrc, '_resolve_realpath'),
    extractFn(scriptSrc, '_node_is_app_bundle'),
    extractFn(scriptSrc, '_node_supports_sqlite'),
    extractFn(scriptSrc, '_node_is_suitable'),
    `_node_is_suitable ${JSON.stringify(bin)}`,
  ].join('\n');
  const file = join(tmp, `suitable-${process.hrtime.bigint()}.sh`);
  writeFileSync(file, body);
  try {
    execFileSync('bash', [file], { stdio: 'ignore', env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('installer node suitability requires node:sqlite', () => {
  for (const [label, src] of [['installer', installerSh], ['service', serviceSh]]) {
    it(`${label} rejects Node 20.20.2 and flagged 22.12, and accepts 22.23.2`, () => {
      const bin = writeFakeNode();
      expect(suitable(src, bin, { FAKE_NODE_VERSION: 'v20.20.2', FAKE_SQLITE_EXIT: '1' })).toBe(false);
      expect(suitable(src, bin, { FAKE_NODE_VERSION: 'v22.12.0', FAKE_SQLITE_EXIT: '1' })).toBe(false);
      expect(suitable(src, bin, { FAKE_NODE_VERSION: 'v22.23.2', FAKE_SQLITE_EXIT: '0' })).toBe(true);
    });

    it(`${label} suitability calls require and does not trust --version`, () => {
      const body = extractFn(src, '_node_is_suitable');
      expect(body).toContain('_node_supports_sqlite');
      expect(body).not.toContain('--version');
      expect(extractFn(src, '_node_supports_sqlite')).toContain("require('node:sqlite')");
    });
  }

  it('PowerShell suitability probes require and captures LASTEXITCODE', () => {
    for (const src of [installerPs1, servicePs1]) {
      const suitableFn = ps1Fn(src, 'Test-NodeSuitable');
      const probe = ps1Fn(src, 'Test-NodeSupportsSqlite');
      expect(suitableFn).toContain('Test-NodeSupportsSqlite');
      expect(suitableFn).not.toContain('-ge 18');
      expect(probe).toContain("require('node:sqlite')");
      expect(probe).toContain('2>&1');
      const lines = probe.split('\n');
      const nativeAt = lines.findIndex((l) => l.includes("-e \"require('node:sqlite')\"") && l.includes('2>&1'));
      expect(nativeAt).toBeGreaterThan(-1);
      expect(lines[nativeAt + 1].trim()).toBe('$code = $LASTEXITCODE');
      expect(probe).toContain('$ErrorActionPreference = $prevEAP');
    }
  });

  it('install exits with a node:sqlite message instead of Node.js >= 18', () => {
    expect(installerSh.slice(installerSh.indexOf('check_deps() {'))).toContain('node:sqlite');
    expect(installerSh.slice(installerSh.indexOf('check_deps() {'))).not.toContain('Node.js >= 18');
    const check = installerPs1.slice(installerPs1.indexOf('function Check-Deps'));
    expect(check).toContain('node:sqlite');
    expect(check).not.toContain('Node.js >= 18');
  });
});
