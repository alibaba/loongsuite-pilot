#!/usr/bin/env node
// Build locally with macOS system tools. No Swift, Xcode, or downloaded binary.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_NAME = 'LoongSuite Pilot Dashboard.app';
const OWNER = 'loongsuite-pilot.dashboard-launcher';
const MARKER = 'pilot-installation.json';
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/dashboard-launcher');

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function optionsWithDefaults(options) {
  const cacheDir = resolve(options.cacheDir ?? join(homedir(), '.loongsuite-pilot'));
  return {
    cacheDir,
    configPath: resolve(options.configPath ?? join(cacheDir, 'config.json')),
    commandPath: resolve(options.commandPath ?? join(homedir(), '.local/bin/loongsuite-pilot')),
    applicationsDir: resolve(options.applicationsDir ?? join(homedir(), 'Applications')),
  };
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function managedInstallation(appPath) {
  try {
    // Do not follow a user-created app/Contents/Resources/marker symlink.
    for (const directory of [appPath, join(appPath, 'Contents'), join(appPath, 'Contents/Resources')]) {
      if (!lstatSync(directory).isDirectory()) return null;
    }
    const markerPath = join(appPath, 'Contents/Resources', MARKER);
    if (!lstatSync(markerPath).isFile()) return null;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker.owner === OWNER && marker.schemaVersion === 1 ? marker : null;
  } catch { return null; }
}

export function installDashboardApp(options = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') return { status: 'unsupported' };
  const { cacheDir, configPath, commandPath, applicationsDir } = optionsWithDefaults(options);
  const run = dependencies.run ?? execFileSync;
  const assets = dependencies.assets ?? ASSETS;
  const appPath = join(applicationsDir, APP_NAME);
  const previous = exists(appPath) ? managedInstallation(appPath) : null;
  if (exists(appPath) && (!previous || previous.cacheDir !== cacheDir)) {
    throw new Error(`Refusing to replace an unmanaged app or another Pilot installation: ${appPath}`);
  }
  if (!existsSync(commandPath)) throw new Error(`Pilot command not found: ${commandPath}`);

  mkdirSync(applicationsDir, { recursive: true });
  // Same filesystem for rename; the existing app survives build/sign failures.
  const stage = mkdtempSync(join(applicationsDir, '.pilot-dashboard-'));
  const stagedApp = join(stage, APP_NAME);
  const backup = join(stage, 'previous.app');
  let preserveBackup = false;
  try {
    run('/usr/bin/osacompile', ['-o', stagedApp, join(assets, 'launcher.applescript')], { timeout: 30_000 });
    const resources = join(stagedApp, 'Contents/Resources');
    // Bind the instance, but resolve the port and the current runtime on EVERY
    // click. No shell PATH/profile, launchd environment, or fixed Node path.
    const launcher = [
      '#!/bin/bash', 'set -euo pipefail',
      `export AGENT_DATA_COLLECTION_CONFIG=${shellQuote(configPath)}`,
      `export LOONGSUITE_PILOT_CACHE_DIR=${shellQuote(cacheDir)}`,
      // This app follows config.dataDir, not an unrelated GUI-session override.
      'unset LOONGSUITE_PILOT_DATA_DIR',
      `if [ ! -f ${shellQuote(commandPath)} ]; then`,
      "  echo 'Pilot is not installed. Install Pilot before opening Dashboard.' >&2",
      '  exit 1', 'fi',
      `exec /bin/bash ${shellQuote(commandPath)} dashboard open`, '',
    ].join('\n');
    writeFileSync(join(resources, 'open-dashboard.sh'), launcher, { mode: 0o755 });
    writeFileSync(join(resources, MARKER), JSON.stringify({
      owner: OWNER, schemaVersion: 1, cacheDir, configPath, commandPath,
    }, null, 2) + '\n');
    copyFileSync(join(assets, 'AppIcon.icns'), join(resources, 'AppIcon.icns'));

    // Keep osacompile's required applet keys (especially LSRequiresCarbon).
    const plist = join(stagedApp, 'Contents/Info.plist');
    for (const [key, type, value] of [
      ['CFBundleIdentifier', '-string', 'com.loongsuite-pilot.dashboard-launcher'],
      ['CFBundleName', '-string', 'LoongSuite Pilot Dashboard'],
      ['CFBundleDisplayName', '-string', 'LoongSuite Pilot Dashboard'],
      ['CFBundleIconFile', '-string', 'AppIcon'],
      ['LSUIElement', '-bool', 'true'],
      ['OSAAppletStayOpen', '-bool', 'false'],
    ]) {
      run('/usr/bin/plutil', ['-replace', key, type, value, plist], { timeout: 5_000 });
    }
    run('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp], { timeout: 15_000 });
    run('/usr/bin/codesign', ['--verify', '--strict', stagedApp], { timeout: 15_000 });
    if (exists(appPath)) {
      const current = managedInstallation(appPath);
      if (!current || current.cacheDir !== cacheDir) {
        throw new Error(`App ownership changed during installation: ${appPath}`);
      }
      renameSync(appPath, backup);
    }
    try { renameSync(stagedApp, appPath); } catch (error) {
      if (exists(backup)) {
        try { renameSync(backup, appPath); } catch {
          preserveBackup = true;
          throw new Error(`Could not restore the previous app; recover it from ${backup}`);
        }
      }
      throw error;
    }
    return { status: 'installed', appPath };
  } finally {
    // Only our mkdtemp staging tree and the validated, replaced app are removed.
    if (!preserveBackup) rmSync(stage, { recursive: true, force: true });
  }
}

export function uninstallDashboardApp(options = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') return { status: 'unsupported' };
  const { cacheDir, configPath, applicationsDir } = optionsWithDefaults(options);
  const appPath = join(applicationsDir, APP_NAME);
  if (!exists(appPath)) return { status: 'absent' };
  const previous = managedInstallation(appPath);
  if (!previous || previous.cacheDir !== cacheDir || previous.configPath !== configPath) {
    return { status: 'preserved', appPath };
  }
  rmSync(appPath, { recursive: true });
  return { status: 'removed', appPath };
}

function main(argv) {
  const [action, ...args] = argv;
  if (!['install', 'uninstall'].includes(action)) throw new Error('Expected install or uninstall');
  const options = {};
  const names = { '--config': 'configPath', '--cache-dir': 'cacheDir', '--command': 'commandPath', '--applications-dir': 'applicationsDir' };
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1]) throw new Error(`Invalid option: ${args[i]}`);
    options[names[args[i]]] = args[i + 1];
  }
  const result = action === 'install' ? installDashboardApp(options) : uninstallDashboardApp(options);
  console.log(`Dashboard app: ${result.status}${result.appPath ? ` (${result.appPath})` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`Dashboard app: ${error.message}`);
    process.exitCode = 1;
  }
}
