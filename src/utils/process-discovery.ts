import { findProcessByCommand, UPDATER_PROCESS_PATTERNS } from './pid-utils.js';

export function isUpdaterRunningOnWindowsSync(): boolean {
  if (process.platform !== 'win32') return false;
  return findProcessByCommand(UPDATER_PROCESS_PATTERNS).running;
}
