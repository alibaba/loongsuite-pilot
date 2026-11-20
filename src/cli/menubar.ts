import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../core/config-loader.js';
import { StatusBarAppManager } from '../status-bar/status-bar-app-manager.js';
import type { RuntimeRecord } from '../status-bar/runtime-writer.js';
import { readJsonFile, resolveHome, writeTextFileAtomic } from '../utils/fs-utils.js';
import { configJsonPath } from '../utils/data-dir.js';
import { isProcessAlive } from '../utils/pid-utils.js';

const HELP = `Usage: loongsuite-pilot menubar <start|stop>

Start or stop the macOS menu bar app without restarting or stopping the collector.
start persists enableStatusBarApp=true and requires a running collector.
stop persists enableStatusBarApp=false and also works when the collector is stopped.
Run this command from a terminal in your macOS desktop session (without sudo).`;

function statusBarEnvOverride(): boolean | undefined {
  let value = process.env.LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP;
  if (value === undefined) return undefined;
  if (process.platform === 'win32') value = value.trim();
  if (value.trim() === '') return undefined;
  return value !== 'false' && value !== '0';
}

async function persistStatusBarEnabled(enabled: boolean): Promise<string> {
  const configPath = configJsonPath();
  let existingText: string | null = null;
  let mode = 0o600;
  try {
    existingText = await fs.readFile(configPath, 'utf8');
    mode = (await fs.stat(configPath)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let config: Record<string, unknown> = {};
  if (existingText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error(`refusing to overwrite invalid JSON config: ${configPath}`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`refusing to overwrite non-object JSON config: ${configPath}`);
    }
    config = parsed as Record<string, unknown>;
    if (config.enableStatusBarApp === enabled) return configPath;
  }

  const updated = { ...config, enableStatusBarApp: enabled };
  await writeTextFileAtomic(configPath, `${JSON.stringify(updated, null, 2)}\n`, {
    expected: existingText === null
      ? { exists: false }
      : { exists: true, content: existingText },
    mode,
  });
  return configPath;
}

export async function runMenubarCommand(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) ||
      (args.length === 2 && ['start', 'stop'].includes(args[0]) && ['--help', '-h'].includes(args[1]))) {
    console.log(HELP);
    return 0;
  }
  if (args.length !== 1 || !['start', 'stop'].includes(args[0])) {
    console.error(HELP);
    return 1;
  }
  if (process.platform !== 'darwin') {
    console.error('The menu bar app is only supported on macOS.');
    return 1;
  }

  try {
    if (args[0] === 'start' && statusBarEnvOverride() === false) {
      console.error('The menu bar app is disabled by LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP. Unset it or set it to true, then retry.');
      return 1;
    }

    const enabled = args[0] === 'start';
    const configPath = await persistStatusBarEnabled(enabled);
    const config = await loadConfig();
    const dataDir = resolveHome(config.dataDir);
    if (args[0] === 'stop') {
      // Stopping does not need a live collector, a package version, or the
      // auto-start setting to remain enabled. It must still clean up a leftover app.
      const manager = new StatusBarAppManager({ dataDir, packageVersion: 'unknown' });
      const result = await manager.stop('cli-request');
      console.log(result.status === 'stopped'
        ? `Menu bar app stopped (PID ${result.pids.join(', ')}). Collector was not stopped. Auto-start disabled in ${configPath}.`
        : `Menu bar app is already stopped. Collector was not stopped. Auto-start disabled in ${configPath}.`);
      if (statusBarEnvOverride() === true) {
        console.warn('Warning: LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP still enables the menu bar and overrides config.json for future Pilot starts.');
      }
      return 0;
    }
    const runtime = await readJsonFile<RuntimeRecord>(path.join(dataDir, 'logs', 'runtime.json'));
    if (runtime?.status !== 'active' || !Number.isInteger(runtime.pid) || runtime.pid <= 0 || !isProcessAlive(runtime.pid)) {
      console.error(`Menu bar auto-start was enabled in ${configPath}, but Pilot is not running or is still starting. Run "loongsuite-pilot start", wait for startup to finish, then retry.`);
      return 1;
    }

    const manager = new StatusBarAppManager({ dataDir, packageVersion: runtime.packageVersion });
    const result = await manager.start();
    if (!result) {
      console.error(`Menu bar app failed to start. Check logs in ${path.join(dataDir, 'logs', 'app-status-bar')}.`);
      return 1;
    }
    console.log(`Menu bar app ${result.status === 'started' ? 'started' : 'is already running'} (PID ${result.pid}). Collector was not restarted. Auto-start enabled in ${configPath}.`);
    return 0;
  } catch (err) {
    console.error(`loongsuite-pilot menubar: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
