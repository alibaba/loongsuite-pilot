import { homedir } from 'node:os';
import path from 'node:path';
import { resolveHome } from './fs-utils.js';

export type DoubaoClient = 'doubao-work' | 'doubao';

/** Shared source-only configuration for probing and the full config loader. */
export function resolveDoubaoWorkSource(listener?: { client?: unknown; logDir?: unknown }): {
  client?: DoubaoClient; logDir?: string;
} {
  return {
    ...(listener?.client === 'doubao' || listener?.client === 'doubao-work' ? { client: listener.client } : {}),
    ...(typeof listener?.logDir === 'string' && listener.logDir.trim()
      ? { logDir: path.resolve(resolveHome(listener.logDir.trim())) } : {}),
  };
}

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
