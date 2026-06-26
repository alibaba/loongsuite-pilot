import { execFileSync } from 'node:child_process';

const UPDATER_QUERY_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*updater-daemon*" } | Select-Object -ExpandProperty ProcessId';

export function isUpdaterRunningOnWindowsSync(): boolean {
  if (process.platform !== 'win32') return false;

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', UPDATER_QUERY_SCRIPT],
      { timeout: 3000, encoding: 'utf-8', windowsHide: true },
    );
    return out.split(/\r?\n/).some(line => /^\d+$/.test(line.trim()));
  } catch {
    return false;
  }
}
