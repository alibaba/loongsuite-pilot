/**
 * event-journal.mjs — Cursor append-only event journal.
 *
 * All Cursor hook events (parent + child sessions + subagent meta) are appended
 * to a single JSONL file. On parent stop, the processor reads the full journal,
 * assembles the turn, then rewrites the journal with only uncompleted events.
 *
 * Append-only writes are serialized with rewrite via a lock file so stop-time
 * journal compaction cannot overwrite events appended by parallel hook processes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const JOURNAL_DIR = path.join(pilotDataDir(), 'state', 'cursor');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'event-journal.jsonl');
const JOURNAL_LOCK_FILE = path.join(JOURNAL_DIR, 'event-journal.lock');
const JOURNAL_LOCK_TIMEOUT_MS = 3000;
const JOURNAL_LOCK_STALE_MS = 2000;
const JOURNAL_LOCK_RETRY_MS = 10;

function ensureJournalDir() {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
}

export function appendEvent(event) {
  ensureJournalDir();
  withJournalLock(() => {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(event) + '\n', 'utf-8');
  });
}

export function readAllEvents() {
  ensureJournalDir();
  return withJournalLock(() => {
    if (!fs.existsSync(JOURNAL_FILE)) return [];
    const content = fs.readFileSync(JOURNAL_FILE, 'utf-8');
    return parseJournalContent(content);
  });
}

export function rewriteJournal(remainingEvents, snapshotEvents = null) {
  ensureJournalDir();
  withJournalLock(() => {
    const finalEvents = Array.isArray(snapshotEvents)
      ? mergeConcurrentAppends(remainingEvents || [], snapshotEvents)
      : (remainingEvents || []);

    if (finalEvents.length === 0) {
      try { fs.unlinkSync(JOURNAL_FILE); } catch {}
      return;
    }

    const tmp = JOURNAL_FILE + `.${process.pid}.tmp`;
    try {
      const content = finalEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, JOURNAL_FILE);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  });
}

function mergeConcurrentAppends(remainingEvents, snapshotEvents) {
  if (!fs.existsSync(JOURNAL_FILE)) return remainingEvents;
  const currentEvents = parseJournalContent(fs.readFileSync(JOURNAL_FILE, 'utf-8'));
  const snapshotCounts = new Map();
  for (const event of snapshotEvents) {
    const key = stableEventKey(event);
    snapshotCounts.set(key, (snapshotCounts.get(key) || 0) + 1);
  }

  const appendedEvents = [];
  for (const event of currentEvents) {
    const key = stableEventKey(event);
    const count = snapshotCounts.get(key) || 0;
    if (count > 0) {
      snapshotCounts.set(key, count - 1);
    } else {
      appendedEvents.push(event);
    }
  }

  return [...remainingEvents, ...appendedEvents];
}

/**
 * Stable dedup key for journal events.
 * Uses semantic fields instead of JSON.stringify to avoid sensitivity to
 * property serialization order (which varies across V8 versions) and
 * reduces overhead for large payloads (e.g. tool_output).
 */
function stableEventKey(event) {
  return [
    event._journal_ts || '',
    event.hook_event || '',
    event.conversation_id || '',
    event.generation_id || '',
    event.tool_use_id || '',
  ].join('\0');
}

function parseJournalContent(content) {
  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip corrupted lines
    }
  }
  return events;
}

function withJournalLock(fn) {
  const lockFd = acquireJournalLock();
  try {
    return fn();
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(JOURNAL_LOCK_FILE); } catch {}
  }
}

function acquireJournalLock() {
  const startedAt = Date.now();
  while (true) {
    try {
      return fs.openSync(JOURNAL_LOCK_FILE, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      removeStaleJournalLock();
      if (Date.now() - startedAt >= JOURNAL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Cursor event journal lock: ${JOURNAL_LOCK_FILE}`);
      }
      sleepSync(JOURNAL_LOCK_RETRY_MS);
    }
  }
}

function removeStaleJournalLock() {
  try {
    const stat = fs.statSync(JOURNAL_LOCK_FILE);
    if (Date.now() - stat.mtimeMs >= JOURNAL_LOCK_STALE_MS) {
      fs.unlinkSync(JOURNAL_LOCK_FILE);
    }
  } catch {}
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

export const CURSOR_JOURNAL_DIR = JOURNAL_DIR;
export const CURSOR_JOURNAL_FILE = JOURNAL_FILE;
export const CURSOR_JOURNAL_LOCK_TIMEOUT_MS = JOURNAL_LOCK_TIMEOUT_MS;
export const CURSOR_JOURNAL_LOCK_STALE_MS = JOURNAL_LOCK_STALE_MS;
