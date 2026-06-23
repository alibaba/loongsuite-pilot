import { describe, expect, it, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../assets/plugins/opencode/plugin.mjs',
);

/**
 * Extract session management functions from plugin.mjs for unit testing.
 * Since the plugin exports only the default hook object, we re-implement
 * the session logic here mirroring the source to test the invariants.
 */

const MAX_SESSIONS = 100;

function createSessionManager() {
  const sessions = new Map();
  const sessionTurnSeqs = new Map();

  function getSession(sessionID) {
    if (!sessionID) return null;
    let s = sessions.get(sessionID);
    if (!s) {
      s = {
        turnSeq: sessionTurnSeqs.get(sessionID) || 0,
        currentTurn: null,
      };
      sessions.set(sessionID, s);
      if (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        clearSession(oldest);
      }
    }
    return s;
  }

  function clearSession(sessionID) {
    const s = sessions.get(sessionID);
    if (s) {
      sessionTurnSeqs.delete(sessionID);
      sessionTurnSeqs.set(sessionID, s.turnSeq);
      if (sessionTurnSeqs.size > MAX_SESSIONS) {
        const oldest = sessionTurnSeqs.keys().next().value;
        sessionTurnSeqs.delete(oldest);
      }
    }
    sessions.delete(sessionID);
  }

  function simulateTurn(sessionID) {
    const session = getSession(sessionID);
    session.turnSeq += 1;
    const turnId = `${sessionID}:t${session.turnSeq}`;
    session.currentTurn = { turnId };
    return turnId;
  }

  return { getSession, clearSession, simulateTurn, sessions, sessionTurnSeqs };
}

describe('opencode plugin session turnSeq persistence', () => {
  let mgr;

  beforeEach(() => {
    mgr = createSessionManager();
  });

  it('restores turnSeq after session.idle clears the session', () => {
    const t1 = mgr.simulateTurn('ses_A');
    expect(t1).toBe('ses_A:t1');

    mgr.clearSession('ses_A');

    const t2 = mgr.simulateTurn('ses_A');
    expect(t2).toBe('ses_A:t2');
  });

  it('turnSeq remains monotonic across multiple idle cycles', () => {
    const results = [];
    for (let i = 1; i <= 5; i++) {
      const turnId = mgr.simulateTurn('ses_B');
      results.push(turnId);
      mgr.clearSession('ses_B');
    }

    expect(results).toEqual([
      'ses_B:t1',
      'ses_B:t2',
      'ses_B:t3',
      'ses_B:t4',
      'ses_B:t5',
    ]);
  });

  it('LRU eviction in getSession preserves turnSeq via clearSession', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const s = mgr.getSession(`ses_fill_${i}`);
      s.turnSeq = 10;
    }
    expect(mgr.sessions.size).toBe(MAX_SESSIONS);

    mgr.getSession('ses_new');
    expect(mgr.sessions.size).toBe(MAX_SESSIONS);

    expect(mgr.sessionTurnSeqs.get('ses_fill_0')).toBe(10);

    const s = mgr.getSession('ses_fill_0');
    expect(s.turnSeq).toBe(10);
  });

  it('sessionTurnSeqs LRU updates key recency on re-save', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const s = mgr.getSession(`ses_lru_${i}`);
      s.turnSeq = i + 1;
      mgr.clearSession(`ses_lru_${i}`);
    }
    expect(mgr.sessionTurnSeqs.size).toBe(MAX_SESSIONS);

    const s = mgr.getSession('ses_lru_0');
    s.turnSeq = 99;
    mgr.clearSession('ses_lru_0');

    mgr.getSession('ses_lru_new');
    mgr.getSession('ses_lru_new').turnSeq = 1;
    mgr.clearSession('ses_lru_new');

    expect(mgr.sessionTurnSeqs.has('ses_lru_0')).toBe(true);
  });

  it('different sessions have independent turnSeq counters', () => {
    expect(mgr.simulateTurn('ses_X')).toBe('ses_X:t1');
    expect(mgr.simulateTurn('ses_Y')).toBe('ses_Y:t1');
    expect(mgr.simulateTurn('ses_X')).toBe('ses_X:t2');

    mgr.clearSession('ses_X');
    expect(mgr.simulateTurn('ses_X')).toBe('ses_X:t3');
    expect(mgr.simulateTurn('ses_Y')).toBe('ses_Y:t2');
  });
});
