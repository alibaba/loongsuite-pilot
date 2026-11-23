import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR_DAEMON = path.resolve(__dirname, '../../../scripts/collector-daemon.js');
const UPDATER_DAEMON = path.resolve(__dirname, '../../../scripts/updater-daemon.js');
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeInstall(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pilot-${kind}-daemon-`));
  tempDirs.push(root);
  const cacheDir = path.join(root, 'cache');
  const binDir = path.join(cacheDir, 'bin');
  const homeDir = path.join(root, 'home-without-install');
  const versionName = '1.0.0_test';
  const versionDir = path.join(cacheDir, 'versions', versionName);
  const distDir = kind === 'collector'
    ? path.join(versionDir, 'dist')
    : path.join(versionDir, 'dist', 'updater');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'current'), versionName, 'utf8');
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, `${kind}.marker`))}, 'ok');\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(versionDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  const daemon = path.join(binDir, `${kind}-daemon.js`);
  fs.copyFileSync(kind === 'collector' ? COLLECTOR_DAEMON : UPDATER_DAEMON, daemon);
  return { root, cacheDir, homeDir, daemon };
}

describe('bootstrap daemons', () => {
  test('collector-daemon resolves current version from LOONGSUITE_PILOT_CACHE_DIR', () => {
    const install = makeInstall('collector');
    const result = spawnSync(process.execPath, [install.daemon], {
      env: {
        ...process.env,
        HOME: install.homeDir,
        USERPROFILE: install.homeDir,
        LOONGSUITE_PILOT_CACHE_DIR: install.cacheDir,
        LOONGSUITE_PILOT_DATA_DIR: path.join(install.root, 'data'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(install.root, 'collector.marker'), 'utf8')).toBe('ok');
  });

  test('updater-daemon resolves current version from LOONGSUITE_PILOT_CACHE_DIR', () => {
    const install = makeInstall('updater');
    const result = spawnSync(process.execPath, [install.daemon], {
      env: {
        ...process.env,
        HOME: install.homeDir,
        USERPROFILE: install.homeDir,
        LOONGSUITE_PILOT_CACHE_DIR: install.cacheDir,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(install.root, 'updater.marker'), 'utf8')).toBe('ok');
  });
});
