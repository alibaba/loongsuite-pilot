import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shellInstallers = [
  'deploy/installer.sh',
  'deploy/installer-inner.sh',
];
const tempDirs: string[] = [];

type JsonObject = Record<string, unknown>;

async function createHarness(
  initialConfig?: string | JsonObject,
  currentText: string | null = '1.1.20-AgentShell_deadbeef\n',
) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lp-installer-config-'));
  tempDirs.push(home);
  const binDir = path.join(home, 'bin');
  const dataDir = path.join(home, 'data');
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const currentPath = path.join(dataDir, 'current');
  if (currentText !== null) await writeFile(currentPath, currentText);
  const innerDataConfigPath = path.join(dataDir, 'configs', 'inner', 'data_config.json');
  await mkdir(path.dirname(innerDataConfigPath), { recursive: true });
  await writeFile(innerDataConfigPath, '{"internal":"must-stay-unchanged"}\n');

  const pilotPath = path.join(binDir, 'loongsuite-pilot');
  await writeFile(pilotPath, `#!/usr/bin/env bash
set -u
calls="$HOME/pilot-calls.log"
env_calls="$HOME/pilot-env-calls.log"
data_dir="\${LOONGSUITE_PILOT_DATA_DIR-<unset>}"
cache_dir="\${LOONGSUITE_PILOT_CACHE_DIR-<unset>}"
printf '%s|%s|%s\n' "\${1:-}" "$data_dir" "$cache_dir" >> "$env_calls"
if [ "$data_dir" != "\${FAKE_EXPECTED_DATA_DIR:-}" ] || [ "$cache_dir" != "\${FAKE_EXPECTED_DATA_DIR:-}" ]; then
  echo "management command received wrong data/cache dirs: $data_dir | $cache_dir" >&2
  exit 5
fi
state="$data_dir/pilot-running"
case "\${1:-}" in
  status)
    if [ "\${FAKE_STATUS_MODE:-}" = "unknown" ]; then
      echo "unexpected status output"
      exit 3
    fi
    if [ -f "$state" ]; then
      echo "loongsuite-pilot test is running"
    elif [ "\${FAKE_INITIAL_STATUS:-running}" = "not-running" ]; then
      echo "loongsuite-pilot test is not running"
      exit 1
    else
      echo "loongsuite-pilot test is running"
    fi
    ;;
  restart)
    echo "restart" >> "$calls"
    count=0
    if [ -f "$HOME/restart-count" ]; then count=$(cat "$HOME/restart-count"); fi
    count=$((count + 1))
    echo "$count" > "$HOME/restart-count"
    if [ "\${FAKE_RESTART_FAIL:-}" = "always" ] || { [ "\${FAKE_RESTART_FAIL:-}" = "once" ] && [ "$count" -eq 1 ]; }; then
      exit 1
    fi
    touch "$state"
    ;;
  *)
    echo "unexpected command: \${1:-}" >&2
    exit 4
    ;;
esac
`);
  await chmod(pilotPath, 0o755);

  const nodeLink = path.join(binDir, 'node');
  await symlink(process.execPath, nodeLink);

  if (initialConfig !== undefined) {
    const content = typeof initialConfig === 'string'
      ? initialConfig
      : `${JSON.stringify(initialConfig, null, 2)}\n`;
    await writeFile(path.join(dataDir, 'config.json'), content);
  }

  return { home, binDir, dataDir, currentPath, innerDataConfigPath };
}

function runInstaller(
  installer: string,
  harness: Awaited<ReturnType<typeof createHarness>>,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync('bash', [
    path.join(rootDir, installer),
    'install',
    '--data-dir',
    harness.dataDir,
    ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: harness.home,
      PATH: `${harness.binDir}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      LOONGSUITE_PILOT_LANG: 'en',
      LOONGSUITE_PILOT_STATUS_RETRIES: '1',
      LOONGSUITE_PILOT_STATUS_RETRY_DELAY: '0',
      FAKE_EXPECTED_DATA_DIR: harness.dataDir,
      ...extraEnv,
    },
  });
}

async function readConfig(dataDir: string) {
  return JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8')) as JsonObject;
}

async function restartCalls(home: string) {
  try {
    return (await readFile(path.join(home, 'pilot-calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function managementCalls(home: string) {
  try {
    return (await readFile(path.join(home, 'pilot-env-calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function snapshot(file: string) {
  return {
    content: await readFile(file, 'utf8'),
    mtimeMs: (await stat(file)).mtimeMs,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.each(shellInstallers)('%s existing-install reporting reconfiguration', (installer) => {
  it('creates an SLS array when config.sls is missing and never downloads a package', async () => {
    const harness = await createHarness({ untouched: { value: 1 } });
    const currentBefore = await snapshot(harness.currentPath);
    const innerDataConfigBefore = await snapshot(harness.innerDataConfigPath);
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
      '--package-url', 'file:///must-not-be-downloaded.tar.gz',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('updating user reporting config only');
    expect(result.stdout).toContain('the installed version is unchanged');
    expect(result.stdout).not.toContain('Downloading:');
    expect(await readConfig(harness.dataDir)).toEqual({
      untouched: { value: 1 },
      sls: [{
        name: 'user-sls',
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'webtracking',
      }],
    });
    expect(await restartCalls(harness.home)).toEqual(['restart']);
    expect(await managementCalls(harness.home)).toEqual([
      `status|${harness.dataDir}|${harness.dataDir}`,
      `restart|${harness.dataDir}|${harness.dataDir}`,
      `status|${harness.dataDir}|${harness.dataDir}`,
    ]);
    expect(await snapshot(harness.currentPath)).toEqual(currentBefore);
    expect(await snapshot(harness.innerDataConfigPath)).toEqual(innerDataConfigBefore);
  });

  it('targets only the custom data dir when the default installation also exists', async () => {
    const harness = await createHarness({
      cms: { licenseKey: 'custom-key', endpoint: 'https://custom-old.example.com' },
    });
    const defaultDataDir = path.join(harness.home, '.loongsuite-pilot');
    await mkdir(defaultDataDir, { recursive: true });
    const defaultConfigPath = path.join(defaultDataDir, 'config.json');
    const defaultCurrentPath = path.join(defaultDataDir, 'current');
    await writeFile(defaultConfigPath, '{"cms":{"licenseKey":"default-key","endpoint":"https://default.example.com"}}\n');
    await writeFile(defaultCurrentPath, '9.9.9-agentshell_default\n');
    const defaultConfigBefore = await snapshot(defaultConfigPath);
    const defaultCurrentBefore = await snapshot(defaultCurrentPath);

    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://custom-new.example.com',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(await readConfig(harness.dataDir)).toEqual({
      cms: { licenseKey: 'custom-key', endpoint: 'https://custom-new.example.com' },
    });
    expect(await snapshot(defaultConfigPath)).toEqual(defaultConfigBefore);
    expect(await snapshot(defaultCurrentPath)).toEqual(defaultCurrentBefore);
    expect(await managementCalls(harness.home)).toEqual([
      `status|${harness.dataDir}|${harness.dataDir}`,
      `restart|${harness.dataDir}|${harness.dataDir}`,
      `status|${harness.dataDir}|${harness.dataDir}`,
    ]);
  });

  it('keeps the original reinstall flow when current does not contain -agentshell', async () => {
    const initial = { untouched: true };
    const harness = await createHarness(initial, '1.1.20_deadbeef\n');
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
      '--prefer-system-node',
      '--package-url', 'file:///definitely-missing-package.tar.gz',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Downloading:');
    expect(result.stdout).not.toContain('updating user reporting config only');
    expect(await readConfig(harness.dataDir)).toEqual(initial);
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('keeps the original reinstall flow when current is missing', async () => {
    const initial = { untouched: true };
    const harness = await createHarness(initial, null);
    const result = runInstaller(installer, harness, [
      '--cms-license-key', 'key',
      '--cms-endpoint', 'https://cms.example.com',
      '--prefer-system-node',
      '--package-url', 'file:///definitely-missing-package.tar.gz',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Downloading:');
    expect(result.stdout).not.toContain('updating user reporting config only');
    expect(await readConfig(harness.dataDir)).toEqual(initial);
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('updates a legacy SLS object in place and removes stale AK credentials', async () => {
    const harness = await createHarness({
      sls: {
        endpoint: 'https://old.example.com',
        project: 'old-project',
        logstore: 'old-logstore',
        mode: 'ak',
        accessKeyId: 'old-id',
        accessKeySecret: 'old-secret',
        batchMaxSize: 42,
        flushIntervalMs: 9000,
      },
      cms: { licenseKey: 'keep-key', endpoint: 'https://keep-cms.example.com' },
    });
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(await readConfig(harness.dataDir)).toEqual({
      sls: {
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'webtracking',
        batchMaxSize: 42,
        flushIntervalMs: 9000,
      },
      cms: { licenseKey: 'keep-key', endpoint: 'https://keep-cms.example.com' },
    });
  });

  it('replaces and deduplicates named user-sls entries while preserving other entries', async () => {
    const harness = await createHarness({
      sls: [
        { name: 'first', endpoint: 'https://first.example.com', project: 'p1', logstore: 'l1' },
        { name: 'user-sls', endpoint: 'https://old-1.example.com', project: 'old', logstore: 'old' },
        { name: 'middle', endpoint: 'https://middle.example.com', project: 'p2', logstore: 'l2' },
        { name: 'user-sls', endpoint: 'https://old-2.example.com', project: 'old', logstore: 'old' },
      ],
    });
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
      '--sls-ak-id', 'new-id',
      '--sls-ak-secret', 'new-secret',
    ]);

    expect(result.status, result.stderr).toBe(0);
    const config = await readConfig(harness.dataDir);
    expect(config.sls).toEqual([
      { name: 'first', endpoint: 'https://first.example.com', project: 'p1', logstore: 'l1' },
      {
        name: 'user-sls',
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'ak',
        accessKeyId: 'new-id',
        accessKeySecret: 'new-secret',
      },
      { name: 'middle', endpoint: 'https://middle.example.com', project: 'p2', logstore: 'l2' },
    ]);
  });

  it('appends user-sls when an array has no matching name', async () => {
    const original = { name: 'other-sls', endpoint: 'https://other.example.com', project: 'p', logstore: 'l' };
    const harness = await createHarness({ sls: [original] });
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
    ]);

    expect(result.status, result.stderr).toBe(0);
    const config = await readConfig(harness.dataDir);
    expect(config.sls).toEqual([
      original,
      {
        name: 'user-sls',
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'webtracking',
      },
    ]);
  });

  it('partially updates CMS, clears workspace, and preserves SLS and otlpTrace', async () => {
    const harness = await createHarness({
      sls: [{ name: 'keep-sls', endpoint: 'https://sls.example.com', project: 'p', logstore: 'l' }],
      cms: {
        licenseKey: 'old-key',
        endpoint: 'https://old-cms.example.com',
        workspace: 'old-workspace',
        debug: true,
      },
      otlpTrace: { endpoint: 'https://otlp.example.com', headers: { authorization: 'keep' } },
    });
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://new-cms.example.com',
      '--cms-workspace=',
      '--collect-log', 'false',
      '--collect-trace', 'true',
      '--service-name-prefix', 'new-prefix',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(await readConfig(harness.dataDir)).toEqual({
      sls: [{ name: 'keep-sls', endpoint: 'https://sls.example.com', project: 'p', logstore: 'l' }],
      cms: {
        licenseKey: 'old-key',
        endpoint: 'https://new-cms.example.com',
        workspace: '',
        debug: true,
      },
      otlpTrace: { endpoint: 'https://otlp.example.com', headers: { authorization: 'keep' } },
      collectLog: false,
      collectTrace: true,
      serviceNamePrefix: 'new-prefix',
    });
    expect(await restartCalls(harness.home)).toEqual(['restart']);
  });

  it('rejects incomplete or invalid config without restarting or modifying the file', async () => {
    const original = '{"sls":"invalid","untouched":true}\n';
    const harness = await createHarness(original);
    const result = runInstaller(installer, harness, [
      '--sls-endpoint', 'https://new.example.com',
      '--sls-project', 'new-project',
      '--sls-logstore', 'new-logstore',
    ]);

    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(harness.dataDir, 'config.json'), 'utf8')).toBe(original);
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('treats is not running as installed and still restarts', async () => {
    const harness = await createHarness({
      cms: { licenseKey: 'key', endpoint: 'https://old.example.com' },
    });
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://new.example.com',
    ], { FAKE_INITIAL_STATUS: 'not-running' });

    expect(result.status, result.stderr).toBe(0);
    expect(await restartCalls(harness.home)).toEqual(['restart']);
  });

  it('uses the default management-command path when PATH has no loongsuite-pilot', async () => {
    const harness = await createHarness({
      cms: { licenseKey: 'key', endpoint: 'https://old.example.com' },
    });
    const defaultBin = path.join(harness.home, '.local', 'bin');
    await mkdir(defaultBin, { recursive: true });
    await rename(
      path.join(harness.binDir, 'loongsuite-pilot'),
      path.join(defaultBin, 'loongsuite-pilot'),
    );
    const minimalPath = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://new.example.com',
    ], { PATH: minimalPath });

    expect(result.status, result.stderr).toBe(0);
    expect(await restartCalls(harness.home)).toEqual(['restart']);
  });

  it('falls through to first-install behavior when the management command is missing', async () => {
    const harness = await createHarness();
    await rm(path.join(harness.binDir, 'loongsuite-pilot'));
    const minimalPath = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const result = runInstaller(installer, harness, [
      '--cms-license-key', 'key',
      '--cms-endpoint', 'https://cms.example.com',
      '--prefer-system-node',
      '--package-url', 'file:///definitely-missing-package.tar.gz',
    ], { PATH: minimalPath });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Downloading:');
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('does not enter the shortcut for auxiliary flags alone', async () => {
    const harness = await createHarness({
      cms: { licenseKey: 'key', endpoint: 'https://old.example.com' },
    });
    const result = runInstaller(installer, harness, [
      '--collect-trace', 'true',
      '--prefer-system-node',
      '--package-url', 'file:///definitely-missing-package.tar.gz',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Downloading:');
    expect(result.stdout).not.toContain('updating user reporting config only');
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('restarts even when the merged config is unchanged', async () => {
    const config = {
      cms: { licenseKey: 'key', endpoint: 'https://same.example.com' },
    };
    const harness = await createHarness(config);
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://same.example.com',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(await readConfig(harness.dataDir)).toEqual(config);
    expect(await restartCalls(harness.home)).toEqual(['restart']);
  });

  it('rejects malformed JSON and incomplete SLS parameters before restart', async () => {
    const malformed = '{"sls":';
    const malformedHarness = await createHarness(malformed);
    const malformedResult = runInstaller(installer, malformedHarness, [
      '--cms-license-key', 'key',
      '--cms-endpoint', 'https://cms.example.com',
    ]);

    expect(malformedResult.status).not.toBe(0);
    expect(await readFile(path.join(malformedHarness.dataDir, 'config.json'), 'utf8')).toBe(malformed);
    expect(await restartCalls(malformedHarness.home)).toEqual([]);

    const incompleteHarness = await createHarness({ untouched: true });
    const incompleteResult = runInstaller(installer, incompleteHarness, [
      '--sls-endpoint', 'https://incomplete.example.com',
    ]);

    expect(incompleteResult.status).not.toBe(0);
    expect(await readConfig(incompleteHarness.dataDir)).toEqual({ untouched: true });
    expect(await restartCalls(incompleteHarness.home)).toEqual([]);
  });

  it('rejects an invalid CMS type without changing SLS', async () => {
    const original = {
      sls: [{ name: 'keep', endpoint: 'https://sls.example.com', project: 'p', logstore: 'l' }],
      cms: ['invalid'],
    };
    const harness = await createHarness(original);
    const result = runInstaller(installer, harness, [
      '--cms-license-key', 'key',
      '--cms-endpoint', 'https://cms.example.com',
    ]);

    expect(result.status).not.toBe(0);
    expect(await readConfig(harness.dataDir)).toEqual(original);
    expect(await restartCalls(harness.home)).toEqual([]);
  });

  it('restores the previous config when restart fails', async () => {
    const original = '{"cms":{"licenseKey":"key","endpoint":"https://old.example.com"}}\n';
    const harness = await createHarness(original);
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://new.example.com',
    ], { FAKE_RESTART_FAIL: 'once' });

    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(harness.dataDir, 'config.json'), 'utf8')).toBe(original);
    expect(await restartCalls(harness.home)).toEqual(['restart', 'restart']);
  });

  it('fails closed when status output is unknown', async () => {
    const original = '{"cms":{"licenseKey":"key","endpoint":"https://old.example.com"}}\n';
    const harness = await createHarness(original);
    const result = runInstaller(installer, harness, [
      '--cms-endpoint', 'https://new.example.com',
    ], { FAKE_STATUS_MODE: 'unknown' });

    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(harness.dataDir, 'config.json'), 'utf8')).toBe(original);
    expect(await restartCalls(harness.home)).toEqual([]);
  });
});
