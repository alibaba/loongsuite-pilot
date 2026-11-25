// Regression guards for the Windows argument-passing defects that aborted the
// installer and made the CLI probes report false negatives.
//
// PowerShell does not preserve double quotes inside a multi-line argument it
// hands to a native command, so a `node -e @'...'@` payload that uses `"` for a
// JS string arrives at Node with the quotes stripped (`require("fs")` becomes
// `require(fs)`) and fails to parse. The installer's payloads therefore stay
// single-quoted, and the CLI probes send their payload over stdin instead of
// through argv.
import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const powershell = process.env.PILOT_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : undefined);

const installer = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const cli = readFileSync(resolve('scripts', 'loongsuite-pilot.ps1'), 'utf8');

/** Every `node -e @' ... '@` payload, with the line its here-string opens on. */
function nodeEvalPayloads(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/-e @'/.test(lines[i])) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^'@/.test(lines[j])) body.push(lines[j++]);
    blocks.push({ line: i + 1, body: body.join('\n') });
    i = j;
  }
  return blocks;
}

describe('Windows node -e payloads survive native argument passing', () => {
  it('finds the installer payloads', () => {
    // Guards against a silently empty sweep (marker rename, file move).
    expect(nodeEvalPayloads(installer).length).toBeGreaterThan(10);
  });

  it('installer payloads contain no double quotes', () => {
    const offenders = nodeEvalPayloads(installer)
      .filter(entry => entry.body.includes('"'))
      .map(entry => entry.line);
    expect(offenders).toEqual([]);
  });

  it('CLI probes pipe their payload in instead of passing it as argv', () => {
    expect(cli).toContain("eval(require('fs').readFileSync(0,'utf8'))");
    expect(cli).not.toMatch(/-e \$probe\b/);
    expect(cli).not.toMatch(/-e \$js\b/);
  });

  it('keeps the CLI subarguments as an array', () => {
    // A statement-block value is pipeline-enumerated, so a single element
    // collapses to a string: $SubArgs[0] then yields a Char and @SubArgs
    // splats the string per character.
    expect(cli).not.toMatch(/\$SubArgs = if \(/);
    expect(cli).toContain('$SubArgs = @()');
  });
});

it.runIf(Boolean(powershell))('preserves span attributes in Legacy argument mode and ConstrainedLanguage', () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-span-argv-'));
  try {
    const dataDir = join(root, 'data dir');
    const cacheDir = join(root, 'cache dir');
    const attributesFile = join(dataDir, 'span-attributes.json');
    const runner = join(root, 'invoke-span-attr.ps1');
    mkdirSync(dataDir);
    mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, 'node-bin'), process.execPath + '\n');
    writeFileSync(runner, [
      '$PSNativeCommandArgumentPassing = "Legacy"',
      '$testArgs = (ConvertFrom-Json -InputObject $env:PILOT_TEST_SPAN_ATTR_JSON).args',
      '$previous = $env:LOONGSUITE_PILOT_SPAN_ATTR_ARGS',
      '$ExecutionContext.SessionState.LanguageMode = "ConstrainedLanguage"',
      '& $env:PILOT_TEST_LAUNCHER span-attr @testArgs',
      '$result = $LASTEXITCODE',
      'if ($env:LOONGSUITE_PILOT_SPAN_ATTR_ARGS -cne $previous) { throw "Span attribute environment was not restored" }',
      'exit $result',
    ].join('\n'));
    const env = {
      ...process.env,
      USERPROFILE: root,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
      PILOT_TEST_LAUNCHER: resolve('scripts/loongsuite-pilot.ps1'),
      LOONGSUITE_PILOT_SPAN_ATTR_ARGS: 'previous value',
    };
    function invoke(...args) {
      return spawnSync(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
      ], { env: { ...env, PILOT_TEST_SPAN_ATTR_JSON: JSON.stringify({ args }) }, encoding: 'utf8' });
    }
    function run(...args) {
      const result = invoke(...args);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return result.stdout.trim();
    }
    const attributes = {
      example: 'value with spaces',
      empty: '',
      'Unicode 字符': '前面 "quoted" 雪',
    };
    for (const [key, value] of Object.entries(attributes)) run('set', key, value);
    run('set', 12, true);
    run('set', 'collection', ['first', 'second']);
    const expected = { ...attributes, '12': 'True', collection: 'first' };
    expect(JSON.parse(readFileSync(attributesFile, 'utf8'))).toEqual(expected);
    expect(run('list')).toContain('example=value with spaces');
    for (const missingValue of [[], [null]]) {
      const missing = invoke('set', 'missing', ...missingValue);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('usage: span-attr set <key> <value>');
      expect(missing.stderr).not.toContain('Span attribute environment was not restored');
    }
    delete env.LOONGSUITE_PILOT_SPAN_ATTR_ARGS;
    for (const key of Object.keys(expected)) run('unset', key);
    expect(run('list')).toBe('(no custom span attributes)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it('probes only its own local dashboard even when Node uses an HTTP proxy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-dashboard-argv-'));
  const dataDir = join(root, 'data dir');
  const instance = createHash('sha256').update(dataDir).digest('hex');
  const requests = [];
  let responseInstance = instance;
  let status = 503;
  const dashboard = createServer((request, response) => {
    requests.push(['dashboard', request.method, request.url]);
    response.writeHead(status, {
      'x-loongsuite-pilot-dashboard': 'metrics-summary-v1',
      'x-loongsuite-pilot-instance': responseInstance,
    }).end();
  });
  const proxy = createServer((request, response) => {
    requests.push(['proxy', request.method, request.url]);
    response.writeHead(502).end();
  });
  try {
    await Promise.all([dashboard, proxy].map(server => once(server.listen(0, '127.0.0.1'), 'listening')));
    const script = join(root, 'probe.ps1');
    const probe = cli.match(/^function Test-DashboardAvailable \{[\s\S]*?(?=^function )/m)[0];
    if (powershell) {
      writeFileSync(script, [
        '$PSNativeCommandArgumentPassing = "Legacy"',
        '$ErrorActionPreference = "Stop"',
        '$DATA_DIR = $env:PILOT_TEST_DATA_DIR',
        'function Resolve-Node { $env:PILOT_TEST_NODE_BIN }',
        probe,
        '$ExecutionContext.SessionState.LanguageMode = "ConstrainedLanguage"',
        'Test-DashboardAvailable -Port ([int]$env:PILOT_TEST_DASHBOARD_PORT)',
      ].join('\n'));
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:no_proxy|https?_proxy|node_options|node_use_env_proxy)$/i.test(key),
    ));
    Object.assign(env, {
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      PILOT_TEST_DATA_DIR: dataDir,
      PILOT_TEST_NODE_BIN: process.execPath,
      PILOT_TEST_DASHBOARD_PORT: String(dashboard.address().port),
    });

    async function run() {
      const options = { env, timeout: 5000 };
      if (powershell) {
        const { stdout, stderr } = await execFileAsync(powershell, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        ], options);
        expect(stderr).toBe('');
        expect(['True', 'False']).toContain(stdout.trim());
        return stdout.trim() === 'True';
      }

      // Exercise the exact embedded Node payload in CI without PowerShell.
      const js = probe.match(/\$probe = @'\r?\n([\s\S]*?)^'@/m)[1];
      try {
        await execFileAsync(process.execPath, [
          '--no-warnings', '-e', js, env.PILOT_TEST_DASHBOARD_PORT, dataDir,
        ], options);
        return true;
      } catch (error) {
        if (error.code !== 1 || error.stderr) throw error;
        return false;
      }
    }

    expect(await run()).toBe(true);
    responseInstance = 'another-installation';
    status = 200;
    expect(await run()).toBe(false);
    expect(requests).toEqual([
      ['dashboard', 'HEAD', '/metrics-summary.json'],
      ['dashboard', 'HEAD', '/metrics-summary.json'],
    ]);
  } finally {
    await Promise.all([dashboard, proxy].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  }
}, 12000);
