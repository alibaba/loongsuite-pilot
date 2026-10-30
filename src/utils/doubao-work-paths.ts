import { homedir } from 'node:os';
import path from 'node:path';

export type DoubaoClient = 'doubao-work' | 'doubao';

/** Select the product explicitly; a log-only override must never relocate native roots. */
export function resolveDoubaoWorkPaths(client: DoubaoClient = 'doubao-work'): {
  userDataRoot?: string; logDir?: string; snapshotRoot?: string; sessionNamespace?: '.doubao' | '.doubaowork';
} {
  const paths = process.platform === 'win32' ? path.win32 : path.posix;
  const product = client === 'doubao' ? 'Doubao' : 'DoubaoWork';
  const userDataRoot = process.platform === 'win32'
    ? paths.join(process.env.LOCALAPPDATA || paths.join(homedir(), 'AppData', 'Local'), product, 'User Data')
    : process.platform === 'darwin'
      ? paths.join(homedir(), 'Library', 'Application Support', product) : undefined;
  return userDataRoot ? { userDataRoot,
    logDir: paths.join(userDataRoot, 'sdk_storage', 'log'),
    snapshotRoot: paths.join(userDataRoot, 'coding', 'snapshot'),
    sessionNamespace: client === 'doubao' ? '.doubao' : '.doubaowork',
  } : {};
}
