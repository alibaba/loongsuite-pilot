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
import { fileURLToPath } from 'node:url';

function pilotDataDir() {
  const configured = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (configured) return configured;
  // The deployed Hook lives in <dataDir>/hooks even when the agent did not
  // inherit the environment of the installer or service.
  const deployedDataDir = fileURLToPath(new URL('../../', import.meta.url));
  if (fs.existsSync(new URL('../cursor-config-path', import.meta.url))
    || fs.existsSync(path.join(deployedDataDir, 'config.json'))) return deployedDataDir;
  return path.join(os.homedir(), '.loongsuite-pilot');
}

export const CURSOR_DATA_DIR = pilotDataDir();
const JOURNAL_DIR = path.join(CURSOR_DATA_DIR, 'state', 'cursor');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'event-journal.jsonl');
const JOURNAL_LOCK_FILE = path.join(JOURNAL_DIR, 'event-journal.lock');
const JOURNAL_LOCK_TIMEOUT_MS = 3000;
const JOURNAL_LOCK_STALE_MS = 2000;
const JOURNAL_LOCK_RETRY_MS = 10;
const SYSTEM_SCOPE = process.env.LOONGSUITE_PILOT_CURSOR_SYSTEM_SCOPE === '1';

if (SYSTEM_SCOPE) process.umask(0o077);

function ensureJournalDir() {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true, mode: SYSTEM_SCOPE ? 0o700 : undefined });
  if (!SYSTEM_SCOPE) return;

  // The system registration shares this directory only across HOMEs of the
  // same UID. Tighten an existing owned journal before reading or writing it.
  const owner = process.geteuid();
  const directory = fs.lstatSync(JOURNAL_DIR);
  if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o022) !== 0) {
    throw new Error('Untrusted Cursor system journal directory');
  }
  if ((directory.mode & 0o077) !== 0) fs.chmodSync(JOURNAL_DIR, 0o700);

  const file = fs.lstatSync(JOURNAL_FILE, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || file.nlink !== 1 || file.uid !== owner || (file.mode & 0o022) !== 0) {
    throw new Error('Untrusted Cursor system journal file');
  }
  if ((file.mode & 0o077) !== 0) fs.chmodSync(JOURNAL_FILE, 0o600);
}

export function appendEvent(event, prepareForAppend) {
  ensureJournalDir();
  return withJournalLock(() => {
    const stored = prepareForAppend ? prepareForAppend(event, readJournal()) : event;
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(stored) + '\n', 'utf-8');
    return stored;
  });
}

function readJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  return parseJournalContent(fs.readFileSync(JOURNAL_FILE, 'utf-8'));
}

export function readAllEvents() {
  ensureJournalDir();
  return withJournalLock(readJournal);
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
      const event = JSON.parse(trimmed);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
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
