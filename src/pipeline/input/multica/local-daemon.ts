import { lstat, opendir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { PipelineConfig } from '../../types.js';
import { digest } from './records.js';

// Set only by local discovery. A pipeline JSON file cannot request profile credentials.
export const daemonProfile = Symbol('daemonProfile');
export type LocalDaemonConfig = PipelineConfig & { [daemonProfile]: string };

const DEFAULT_HEALTH_PORT = 19514;
const MAX_PROFILE_ENTRIES = 64;

async function findDaemon(home: string, profile: string): Promise<LocalDaemonConfig | undefined> {
  const dir = profile ? path.join(home, 'profiles', profile) : home;
  const pidFile = path.join(dir, 'daemon.pid');
  const logFile = path.join(dir, 'daemon.log');
  try {
    const [pidStat, logStat] = await Promise.all([lstat(pidFile), lstat(logFile)]);
    if (!pidStat.isFile() || pidStat.size > 32 || !logStat.isFile()) return;
    const pidText = (await readFile(pidFile, 'utf8')).trim();
    if (!/^[1-9]\d{0,9}$/.test(pidText)) return;
    const pid = Number(pidText);
    if (pid > 0x7fffffff) return;
    process.kill(pid, 0);
    // Multica uses the sum of the UTF-8 bytes of the profile name for its local health port.
    const port = profile ? DEFAULT_HEALTH_PORT + 1 + Buffer.from(profile).reduce((sum, byte) => sum + byte, 0) % 1000
      : DEFAULT_HEALTH_PORT;
    return {
      [daemonProfile]: path.join(dir, 'config.json'),
      configName: 'multica-local-daemon-' + (profile ? digest(profile).slice(0, 16) : 'default'),
      inputs: [{Type: 'input_multica', CollectionMode: 'on', LogFiles: [logFile],
        DaemonHealthUrls: [`http://127.0.0.1:${port}/health`], LocalDaemonPid: pid}],
      flushers: [],
    };
  } catch {
    // Missing or inaccessible files and a stale daemon PID do not start collection.
    return undefined;
  }
}

export async function discoverLocalMulticaDaemons(): Promise<LocalDaemonConfig[]> {
  const home = path.join(homedir(), '.multica');
  const profiles = [''];
  try {
    const directory = await opendir(path.join(home, 'profiles'));
    let entries = 0;
    for await (const entry of directory) {
      if (entry.isDirectory()) profiles.push(entry.name);
      if (++entries >= MAX_PROFILE_ENTRIES) break;
    }
  } catch {
    // The default profile may still exist.
  }
  const candidates = await Promise.all(profiles.map(profile => findDaemon(home, profile)));
  return candidates.filter(config => config !== undefined);
}
