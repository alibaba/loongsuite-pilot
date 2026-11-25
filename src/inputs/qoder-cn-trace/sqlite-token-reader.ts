import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHome } from '../../utils/fs-utils.js';
import { readSqliteTokensFromCandidates, type SqliteTokenResult } from '../qoder-trace/sqlite-token-reader.js';

/** Path tail shared by the standalone-app layouts, appended to an app-support dir name. */
const DB_PATH_SEGMENTS = ['SharedClientCache', 'cache', 'db', 'local.db'] as const;

export async function readSqliteTokensForSession(sessionId: string): Promise<SqliteTokenResult> {
  // Qoder CN records the selected model in chat_record.extra, including Auto,
  // and writes the assistant-side model separately in chat_message.model_info.
  return readSqliteTokensFromCandidates(sessionId, resolveQoderCnDbPaths(), () => true);
}

/**
 * Qoder CN ships more than one data layout, and both share the same `~/.qoder-cn`
 * config directory:
 *
 *   IDE plugin host  ~/.qoder-cn/shared_client/cache/db/local.db
 *   standalone app   <app-support>/QoderCN/SharedClientCache/cache/db/local.db
 *
 * Config-dir presence therefore says nothing about where the DB lives, so probe every
 * accessible candidate and let `session_id` decide ownership: a candidate that does not
 * contain the session simply returns zero rows and we move on. Session ids are per-session
 * UUIDs, so a wrong candidate can never mis-attribute data.
 *
 * `<app-support>/Qoder/SharedClientCache/...` is deliberately NOT a candidate: that is the
 * international Qoder desktop DB. No CN build has been observed using it, and it can be
 * hundreds of MB — opening it on every enrichment would cost real IO for no benefit.
 *
 * DO NOT use the matched path to derive or rewrite `gen_ai.agent.type`. Identity comes only
 * from hook deploy location -> hook script agent id -> the hook record. `qoder-trace` does
 * relabel qoder -> qoder-idea via `isIdeaDbPath()`, which tests
 * `includes('.qoder/shared_client')`; `.qoder-cn/shared_client` escapes that test purely
 * because the substring is `-cn/` rather than `/`. That is a coincidence, not a guarantee.
 * Copying that pattern here, or loosening the test, would mislabel every Qoder CN user.
 */
export function resolveQoderCnDbPaths(): string[] {
  const appSupportRoot = process.platform === 'darwin'
    ? resolveHome('~/Library/Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : resolveHome('~/.config');

  // Ordered by observed hit rate.
  const candidates = [
    path.join(os.homedir(), '.qoder-cn', 'shared_client', 'cache', 'db', 'local.db'),
    path.join(appSupportRoot, 'QoderCN', ...DB_PATH_SEGMENTS),
    path.join(appSupportRoot, 'Qoder CN', ...DB_PATH_SEGMENTS),
  ];

  const available: string[] = [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      available.push(candidate);
    } catch {
      continue;
    }
  }
  return available;
}

