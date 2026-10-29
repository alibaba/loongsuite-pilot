import { homedir } from 'node:os';
import path from 'node:path';

/** Platform-owned native roots; a log-only override must never relocate them. */
export function resolveDoubaoWorkPaths(): { userDataRoot?: string; logDir?: string; snapshotRoot?: string } {
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  const userDataRoot = process.platform === 'win32'
    ? paths.join(process.env.LOCALAPPDATA || paths.join(homedir(), 'AppData', 'Local'), 'DoubaoWork', 'User Data')
    : process.platform === 'darwin'
      ? paths.join(homedir(), 'Library', 'Application Support', 'DoubaoWork') : undefined;
  return userDataRoot ? { userDataRoot,
    logDir: paths.join(userDataRoot, 'sdk_storage', 'log'),
    snapshotRoot: paths.join(userDataRoot, 'coding', 'snapshot'),
  } : {};
}
