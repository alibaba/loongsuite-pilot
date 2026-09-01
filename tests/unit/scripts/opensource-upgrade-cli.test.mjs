import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shellCli = path.join(projectRoot, 'scripts', 'loongsuite-pilot.sh');
const powershellCli = path.join(projectRoot, 'scripts', 'loongsuite-pilot.ps1');
const temporaryRoots = [];

function makeTemporaryRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

async function builtEdition(proprietary) {
  const root = makeTemporaryRoot('pilot-build-edition-');
  const output = path.join(root, 'cli-probe.cjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'cli-probe.ts')],
    outfile: output,
    platform: 'node',
    target: 'es2022',
    format: 'cjs',
    bundle: true,
    define: {
      __PROPRIETARY_BUILD__: String(proprietary),
    },
    logLevel: 'silent',
  });

  const result = spawnSync(process.execPath, [output, '--build-edition'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function shellFixture(edition) {
  const root = makeTemporaryRoot('pilot-upgrade-cli-');
  const profile = path.join(root, 'profile');
  const cacheDir = path.join(profile, '.loongsuite-pilot');
  const versionDir = path.join(cacheDir, 'versions', 'test-version');
  const fakeBin = path.join(root, 'bin');
  const tempDir = path.join(root, 'tmp');
  const curlArgs = path.join(root, 'curl-args.txt');
  const installerArgs = path.join(root, 'installer-args.txt');

  fs.mkdirSync(path.join(versionDir, 'dist'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'current'), 'test-version\n');
  fs.writeFileSync(path.join(cacheDir, 'node-bin'), `${process.execPath}\n`);
  fs.writeFileSync(
    path.join(versionDir, 'dist', 'cli-probe.cjs'),
    'if (process.argv.includes("--build-edition")) process.stdout.write(process.env.PILOT_TEST_EDITION || "");\n',
  );
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$PILOT_TEST_CURL_ARGS"
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
cat > "$output" <<'INSTALLER'
#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PILOT_TEST_INSTALLER_ARGS"
INSTALLER
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    HOME: profile,
    LOONGSUITE_PILOT_DATA_DIR: cacheDir,
    LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    TMPDIR: tempDir,
    PILOT_TEST_EDITION: edition,
    PILOT_TEST_CURL_ARGS: curlArgs,
    PILOT_TEST_INSTALLER_ARGS: installerArgs,
  };

  return {
    curlArgs,
    installerArgs,
    run(...args) {
      return spawnSync('bash', [shellCli, ...args], {
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });
    },
  };
}

function powershellFixture(edition) {
  const root = makeTemporaryRoot('pilot-upgrade-powershell-');
  const profile = path.join(root, 'profile');
  const cacheDir = path.join(profile, '.loongsuite-pilot');
  const versionDir = path.join(cacheDir, 'versions', 'test-version');

  fs.mkdirSync(path.join(versionDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'current'), 'test-version\n');
  fs.writeFileSync(path.join(cacheDir, 'node-bin'), `${process.execPath}\n`);
  fs.writeFileSync(
    path.join(versionDir, 'dist', 'cli-probe.cjs'),
    'if (process.argv.includes("--build-edition")) process.stdout.write(process.env.PILOT_TEST_EDITION || "");\n',
  );

  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powershellCli, 'help'],
    {
      env: {
        ...process.env,
        USERPROFILE: profile,
        LOONGSUITE_PILOT_DATA_DIR: cacheDir,
        LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
        PILOT_TEST_EDITION: edition,
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}

describe('open-source upgrade build gate', () => {
  it('reports the edition from the existing compile-time build flag', async () => {
    await expect(builtEdition(false)).resolves.toBe('opensource');
    await expect(builtEdition(true)).resolves.toBe('proprietary');
  });

  it('does not use mutable config or updater files as the edition signal', () => {
    const shell = fs.readFileSync(shellCli, 'utf8');
    const powershell = fs.readFileSync(powershellCli, 'utf8');
    const shellGate = shell.slice(shell.indexOf('build_edition()'), shell.indexOf('resolve_previous_version()'));
    const powershellGate = powershell.slice(
      powershell.indexOf('function Get-BuildEdition'),
      powershell.indexOf('function Resolve-PreviousVersion'),
    );

    for (const gate of [shellGate, powershellGate]) {
      expect(gate).toContain('--build-edition');
      expect(gate).not.toContain('config.json');
      expect(gate).not.toContain('packageUrl');
      expect(gate).not.toContain('updater-daemon.js');
    }
  });
});

const describeShellRuntime = process.platform === 'win32' ? describe.skip : describe;

describeShellRuntime('open-source upgrade shell command', () => {
  it('shows the command only for open-source builds', () => {
    const opensource = shellFixture('opensource').run('help');
    const proprietary = shellFixture('proprietary').run('help');
    const unidentified = shellFixture('').run('help');

    expect(opensource.status).toBe(0);
    expect(opensource.stdout).toContain('upgrade [opts]');
    expect(proprietary.status).toBe(0);
    expect(proprietary.stdout).not.toContain('upgrade [opts]');
    expect(unidentified.status).toBe(0);
    expect(unidentified.stdout).not.toContain('upgrade [opts]');
  });

  it('downloads the fixed public installer and upgrades to latest', () => {
    const fixture = shellFixture('opensource');
    const result = fixture.run('upgrade');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(fixture.curlArgs, 'utf8')).toContain(
      'https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh',
    );
    expect(fs.readFileSync(fixture.installerArgs, 'utf8')).toBe(
      `upgrade\n--data-dir\n${path.dirname(fixture.installerArgs)}/profile/.loongsuite-pilot\n`,
    );
  });

  it('forwards a requested version to the installer', () => {
    const fixture = shellFixture('opensource');
    const result = fixture.run('upgrade', '--version', '1.6.0');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(fixture.installerArgs, 'utf8')).toBe(
      `upgrade\n--data-dir\n${path.dirname(fixture.installerArgs)}/profile/.loongsuite-pilot\n--version\n1.6.0\n`,
    );
  });

  it('rejects invalid versions before downloading', () => {
    const fixture = shellFixture('opensource');
    const result = fixture.run('upgrade', '--version', '../../commercial');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid version');
    expect(fs.existsSync(fixture.curlArgs)).toBe(false);
  });

  it('rejects the command for proprietary or unidentified builds', () => {
    for (const edition of ['proprietary', '']) {
      const fixture = shellFixture(edition);
      const result = fixture.run('upgrade');

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Unknown command: upgrade');
      expect(fs.existsSync(fixture.curlArgs)).toBe(false);
    }
  });
});

describe('open-source upgrade PowerShell contract', () => {
  it('uses the same build gate, fixed installer, and version forwarding', () => {
    const script = fs.readFileSync(powershellCli, 'utf8');

    expect(script).toContain('function Test-OpenSourceBuild');
    expect(script).toContain('if (Test-OpenSourceBuild)');
    expect(script).toContain('loongsuite-pilot/installer.ps1');
    expect(script).toContain('"-DataDir", $DATA_DIR');
    expect(script).toContain('$env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR');
    expect(script).toContain('$installerArgs += @("-Version", $version)');
    expect(script).toContain('"upgrade" {');
  });
});

const describePowerShellRuntime = process.platform === 'win32' ? describe : describe.skip;

describePowerShellRuntime('open-source upgrade PowerShell runtime', () => {
  it('shows the command only for open-source builds', () => {
    const opensource = powershellFixture('opensource');
    const proprietary = powershellFixture('proprietary');

    expect(opensource.status).toBe(0);
    expect(opensource.stdout).toContain('upgrade [opts]');
    expect(proprietary.status).toBe(0);
    expect(proprietary.stdout).not.toContain('upgrade [opts]');
  });
});
