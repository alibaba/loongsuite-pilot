import os from 'node:os';
import path from 'node:path';
import { queryReadonly } from '../../utils/node-sqlite.js';

export function resolveQoderTurnCreditsDbPath(agentId: 'qoder' | 'qoder-cn'): string {
  const home = os.homedir();
  const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(appData, agentId === 'qoder' ? 'com.qoder.app.stable' : 'com.qodercn.app.stable', 'main.sqlite');
}

/** A decimal is the actual turn debit; null is pending; undefined is unavailable. */
export async function readQoderTurnCredits(
  dbPath: string, sessionId: string, requestSetId: string,
): Promise<number | null | undefined> {
  try {
    // Both keys scope the query to the native turn. The request-set column
    // prevents attaching a previous charge after a reply was replaced.
    const rows = await queryReadonly<{ turn_credits: number }>(dbPath,
      `SELECT turn_credits FROM chat_session_messages
       WHERE session_id = ? AND turn_id = ? AND turn_credits_request_set_id = ?
         AND role = 'assistant' AND status != 'streaming' AND turn_credits IS NOT NULL
       LIMIT 2`, [sessionId, requestSetId, requestSetId]);
    if (rows.length === 0) return null;
    if (rows.length !== 1) return undefined;
    const amount = rows[0]!.turn_credits;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
  } catch (error) {
    // Retry a busy/locked database within the same turn's deadline. Older
    // clients without this table, and runtimes without SQLite, settle normally.
    const errorCode = (error as { errcode?: number }).errcode;
    return errorCode !== undefined && [5, 6].includes(errorCode & 0xff) ? null : undefined;
  }
}
