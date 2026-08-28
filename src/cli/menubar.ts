import * as path from 'node:path';
import { loadConfig } from '../core/config-loader.js';
import { StatusBarAppManager } from '../status-bar/status-bar-app-manager.js';
import type { RuntimeRecord } from '../status-bar/runtime-writer.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { isProcessAlive } from '../utils/pid-utils.js';

const HELP = `Usage: loongsuite-pilot menubar <start|stop>

Start or stop the macOS menu bar app without restarting or stopping the collector.
start requires a running collector and enableStatusBarApp to be enabled.
stop also works when the collector is stopped or the menu bar app is disabled.
Run this command from a terminal in your macOS desktop session (without sudo).`;

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
    const config = await loadConfig();
    const dataDir = resolveHome(config.dataDir);
    if (args[0] === 'stop') {
      // Stopping does not need a live collector, a package version, or the
      // auto-start setting to remain enabled. It must still clean up a leftover app.
      const manager = new StatusBarAppManager({ dataDir, packageVersion: 'unknown' });
      const result = await manager.stop('cli-request');
      console.log(result.status === 'stopped'
        ? `Menu bar app stopped (PID ${result.pids.join(', ')}). Collector was not stopped.`
        : 'Menu bar app is already stopped. Collector was not stopped.');
      return 0;
    }
    if (!config.statusBar.enabled) {
      console.error('The menu bar app is disabled. Enable enableStatusBarApp in config.json or set LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP=true.');
      return 1;
    }
    const runtime = await readJsonFile<RuntimeRecord>(path.join(dataDir, 'logs', 'runtime.json'));
    if (runtime?.status !== 'active' || !Number.isInteger(runtime.pid) || runtime.pid <= 0 || !isProcessAlive(runtime.pid)) {
      console.error('Pilot is not running or is still starting. Run "loongsuite-pilot start", wait for startup to finish, then retry.');
      return 1;
    }

    const manager = new StatusBarAppManager({ dataDir, packageVersion: runtime.packageVersion });
    const result = await manager.start();
    if (!result) {
      console.error(`Menu bar app failed to start. Check logs in ${path.join(dataDir, 'logs', 'app-status-bar')}.`);
      return 1;
    }
    console.log(`Menu bar app ${result.status === 'started' ? 'started' : 'is already running'} (PID ${result.pid}). Collector was not restarted.`);
    return 0;
  } catch (err) {
    console.error(`loongsuite-pilot menubar: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
