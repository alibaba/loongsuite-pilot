/**
 * Shared infrastructure for hook transcript processors.
 * Provides file I/O, offset tracking, logging, and common utilities
 * used by both qoder-hook-processor.mjs and qoderwork-hook-processor.mjs.
 */

import fs from 'node:fs';
import { filterWorkspaceJsonLines } from './workspace-privacy.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildQoderHookRecord,
  loadHookRuntimeConfig,
} from '../agent-event-normalizer.mjs';
import { decodePayload } from './decode-payload.mjs';
import { withSyncFileLock } from './sync-file-lock.mjs';

const ENABLE_LOGGING = true;
export const HOOKS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LOONGSUITE_PILOT_DATA_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR
  || path.join(os.homedir(), '.loongsuite-pilot');
export const LOONGSUITE_PILOT_LOGS_BASE_DIR = (() => {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'logs');
})();

// --- CLI argument parsing ---------------------------------------------------

export function parseArgs() {
  const args = process.argv.slice(2);
  let agentId = '';
  let logPrefix = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && i + 1 < args.length) { agentId = args[++i]; }
    else if (args[i] === '--log-prefix' && i + 1 < args.length) { logPrefix = args[++i]; }
  }
  if (!agentId) {
    process.stderr.write('hook-processor: --agent-id is required\n');
    process.exit(1);
  }
  return { agentId, logPrefix: logPrefix || agentId };
}

// --- Date helper (local timezone) --------------------------------------------

export function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// --- Logging ----------------------------------------------------------------

export function getDebugLogFile(agentId) {
  const day = getLocalDateString();
  return path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'debug', `${agentId}-debug-${day}.log`);
}

export function getErrorLogFile(agentId) {
  const day = getLocalDateString();
  return path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'errors', `${agentId}-error-${day}.log`);
}

export function logDebug(agentId, message) {
  if (!ENABLE_LOGGING) return;
  try {
    const file = getDebugLogFile(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(file, `[${ts}] ${message}\n`, 'utf-8');
  } catch { /* best-effort */ }
}

// --- Line record persistence (per agent-id and session) ---------------------

function aggregateLineRecordFile(agentId) {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', 'hooks', `${agentId}-line-records.json`);
}

function deployedLegacyLineRecordFile(agentId) {
  return path.join(HOOKS_DIR, `.line_records.${agentId}.json`);
}

function sessionLineRecordDir(agentId) {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', 'hooks', `${agentId}-line-records`);
}

function sessionLineRecordFile(agentId, sessionId) {
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(sessionLineRecordDir(agentId), `${sessionHash}.json`);
}

function readJsonObject(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveJsonObject(file, value) {
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    }
    return false;
  }
}

function saveSessionLineRecord(agentId, sessionId, record) {
  return saveJsonObject(sessionLineRecordFile(agentId, sessionId), record);
}

function reconcileAggregateLineRecord(agentId, requestedSessionId) {
  const sources = [
    aggregateLineRecordFile(agentId),
    deployedLegacyLineRecordFile(agentId),
  ];

  for (const source of sources) {
    const records = readJsonObject(source);
    if (!records) continue;

    for (const [transcriptPath, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const sessionId = typeof value.session_id === 'string' ? value.session_id : '';
      if (!sessionId || sessionId !== requestedSessionId) continue;

      const target = sessionLineRecordFile(agentId, sessionId);
      const existing = readJsonObject(target);
      const candidate = {
        ...value,
        session_id: sessionId,
        transcript_path: transcriptPath,
      };
      if (!existing || isLineRecordNewer(candidate, existing)) {
        saveSessionLineRecord(agentId, sessionId, candidate);
      }
    }
  }
}

function isLineRecordNewer(candidate, existing) {
  if (candidate.transcript_path === existing.transcript_path) {
    // Cursor progress for one transcript is monotonic. An older implementation
    // may write a later timestamp with a stale line count after a concurrent
    // read-modify-write, but that must never rewind the per-session primary.
    return Number(candidate.last_line_count) > Number(existing.last_line_count);
  }

  const candidateUpdated = typeof candidate.updated_at === 'string' ? candidate.updated_at : '';
  const existingUpdated = typeof existing.updated_at === 'string' ? existing.updated_at : '';
  return Boolean(candidateUpdated)
    && (!existingUpdated || candidateUpdated > existingUpdated);
}

function updateAggregateShadow(file, transcriptPath, record, reset) {
  const result = withSyncFileLock(`${file}.lock`, 1_000, 30_000, () => {
    const records = readJsonObject(file) || {};
    const existing = records[transcriptPath];
    if (!reset && existing?.session_id === record.session_id
      && Number(existing.last_line_count) > Number(record.last_line_count)) {
      return true;
    }
    records[transcriptPath] = {
      session_id: record.session_id,
      last_line_count: record.last_line_count,
      updated_at: record.updated_at,
      ...(record.byte_cursor ? { byte_cursor: record.byte_cursor } : {}),
    };
    return saveJsonObject(file, records);
  });

  return result.acquired ? result.value : false;
}

function rollbackShadowFiles(agentId) {
  const files = [aggregateLineRecordFile(agentId)];
  const deployedHooksDir = path.join(LOONGSUITE_PILOT_DATA_DIR, 'hooks');
  if (path.resolve(HOOKS_DIR) === path.resolve(deployedHooksDir)) {
    files.push(deployedLegacyLineRecordFile(agentId));
  }
  return files;
}

export function loadLineRecord(agentId, sessionId) {
  if (!sessionId) return {};
  const file = sessionLineRecordFile(agentId, sessionId);

  // Older releases stored every transcript in one per-agent JSON object,
  // either in the persistent state directory or beside the deployed hooks.
  // Reconcile the requested session lazily. The aggregate files remain as
  // locked rollback shadows, so a forward upgrade after an old-version rollback
  // can recover any cursor advances made while that version was active.
  reconcileAggregateLineRecord(agentId, sessionId);
  return readJsonObject(file) || {};
}

export function updateLineRecord(agentId, transcriptPath, sessionId, endLine, byteCursor, reset = false) {
  const record = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    last_line_count: endLine,
    ...(byteCursor ? { byte_cursor: byteCursor } : {}),
    updated_at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
  };
  const ok = saveSessionLineRecord(agentId, sessionId, record);
  if (ok) {
    logDebug(agentId, `Updated record: ${transcriptPath} -> ${endLine} lines`);
    for (const shadow of rollbackShadowFiles(agentId)) {
      if (!updateAggregateShadow(shadow, transcriptPath, record, reset)) {
        logDebug(agentId, `Warning: Failed to update rollback cursor shadow ${shadow}`);
      }
    }
  } else {
    logDebug(agentId, 'Warning: Failed to save line records');
  }
  return ok;
}

// --- Transcript reading -----------------------------------------------------

export function getTranscriptLineCount(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return 0;
    // Byte scan over the raw Buffer: decoding a multi-MB transcript into a UTF-16
    // string and walking it per-character costs ~35ms on a 13MB file, paid on the
    // user's interactive path every event. 0x0A only ever encodes U+000A in UTF-8
    // (it never appears as a continuation byte), so counting the byte is exactly
    // equivalent to counting '\n' in the decoded string -- including the +1 for a
    // final line with no trailing newline, which drives the persisted cursor.
    const buf = fs.readFileSync(transcriptPath);
    if (buf.length === 0) return 0;
    let count = 0;
    let idx = buf.indexOf(10);
    while (idx !== -1) {
      count++;
      idx = buf.indexOf(10, idx + 1);
    }
    if (buf[buf.length - 1] !== 10) count++;
    return count;
  } catch {
    return 0;
  }
}

export function getLineRangeInfo(agentId, transcriptPath, sessionId, knownCurrentCount) {
  const record = loadLineRecord(agentId, sessionId);
  const hasRecordedOffset = Number.isFinite(record.last_line_count)
    && record.last_line_count >= 0;
  let lastCount = hasRecordedOffset ? record.last_line_count : 0;
  const recordedSession = record.session_id || '';
  const recordedTranscript = record.transcript_path || '';
  let reason = hasRecordedOffset ? 'incremental' : 'missing-cursor';

  // Callers that already hold a transcript snapshot can pass its line count so
  // cursor validation does not read the complete file a second time.
  const currentCount = Number.isFinite(knownCurrentCount)
    ? knownCurrentCount
    : getTranscriptLineCount(transcriptPath);

  if (recordedSession && recordedSession !== sessionId) {
    logDebug(agentId, `Session changed: ${recordedSession} -> ${sessionId}, reset to 0`);
    lastCount = 0;
    reason = 'session-changed';
  }
  if (recordedTranscript && recordedTranscript !== transcriptPath) {
    logDebug(agentId, `Transcript changed for session ${sessionId}, reset to 0`);
    lastCount = 0;
    reason = 'transcript-changed';
  }
  if (currentCount === 0) {
    logDebug(agentId, 'Transcript is empty');
    return null;
  }
  if (currentCount === lastCount) {
    logDebug(agentId, `No new lines (count: ${currentCount})`);
    return null;
  }
  if (currentCount < lastCount) {
    logDebug(agentId, `File truncated (${lastCount} -> ${currentCount}), sending all`);
    lastCount = 0;
    reason = 'truncated';
  }

  logDebug(agentId, `Range: ${lastCount} -> ${currentCount} (${reason})`);
  return { startLine: lastCount, endLine: currentCount, reason };
}

/**
 * Compatibility API for a transient mixed-version deployment: the shared
 * module may be replaced before an older deployed processor that still imports
 * the tuple form. Current in-tree processors use getLineRangeInfo().
 */
export function getLineRange(agentId, transcriptPath, sessionId) {
  const info = getLineRangeInfo(agentId, transcriptPath, sessionId);
  return info ? [info.startLine, info.endLine] : null;
}

// Reads the transcript exactly once and returns both its line count and the raw
// split lines. A caller can feed lineCount to getLineRangeInfo (as
// knownCurrentCount) and slice the new range from allLines, so the QoderWork /
// QwenWorkCN processors no longer read the whole file twice per hook event. The
// lineCount rule matches getTranscriptLineCount byte-for-byte: a final line with
// no trailing newline still counts.
export function readTranscriptSnapshotLines(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return { lineCount: 0, allLines: [] };
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    if (content.length === 0) return { lineCount: 0, allLines: [] };
    const allLines = content.split('\n');
    const lineCount = content[content.length - 1] !== '\n'
      ? allLines.length
      : Math.max(0, allLines.length - 1);
    return { lineCount, allLines };
  } catch {
    return { lineCount: 0, allLines: [] };
  }
}

const WORK_TRANSCRIPT_WINDOW = 32 * 1024 * 1024;
const WORK_UNTERMINATED_ROW_LIMIT = 1024 * 1024;
const WORK_TRANSCRIPT_SCAN_CHUNK = 256 * 1024;

function readTranscriptBytes(fd, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const bytes = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (!bytes) break;
    read += bytes;
  }
  return buffer.subarray(0, read);
}

function isCompleteTranscriptRow(bytes) {
  if (bytes.length > WORK_UNTERMINATED_ROW_LIMIT) return false;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isWhitespacePrefix(bytes, end) {
  for (let i = 0; i < end; i++) {
    const byte = bytes[i];
    if (byte !== 0x20 && (byte < 0x09 || byte > 0x0d)) return false;
  }
  return true;
}

function offsetAtLine(fd, size, lines) {
  if (lines === 0) return { offset: 0, needsDelimiter: false };
  let lastBoundary = 0;
  for (let offset = 0; offset < size;) {
    const chunk = readTranscriptBytes(fd, offset, Math.min(WORK_TRANSCRIPT_SCAN_CHUNK, size - offset));
    if (!chunk.length) break;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) {
      lastBoundary = offset + i + 1;
      if (--lines === 0) return { offset: lastBoundary, needsDelimiter: false };
    }
    offset += chunk.length;
  }
  // Older cursors counted a final record even without a newline.
  if (lines === 1 && lastBoundary < size && size - lastBoundary <= WORK_UNTERMINATED_ROW_LIMIT
    && isCompleteTranscriptRow(readTranscriptBytes(fd, lastBoundary, size - lastBoundary))) {
    return { offset: size, needsDelimiter: true };
  }
  return undefined;
}

function bootstrapTailStart(fd, size, startOffset, lines, needsDelimiter) {
  const cutoff = size - WORK_TRANSCRIPT_WINDOW;
  // Count the skipped lines for the legacy rollback cursor. A tail-only
  // search would find a byte boundary but could not recover the line count.
  for (let offset = startOffset; offset < size;) {
    const chunk = readTranscriptBytes(fd, offset, Math.min(WORK_TRANSCRIPT_SCAN_CHUNK, size - offset));
    if (!chunk.length) break;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) {
      if (needsDelimiter) needsDelimiter = false;
      else lines++;
      if (offset + i + 1 >= cutoff) return { offset: offset + i + 1, lines };
    }
    offset += chunk.length;
  }
  return null;
}

function cursorWitness(fd, offset, length = Math.min(offset, 64)) {
  return crypto.createHash('sha256').update(readTranscriptBytes(fd, offset - length, length)).digest('hex');
}

function matchesByteCursor(fd, stat, saved) {
  if (saved.dev !== stat.dev || saved.ino !== stat.ino || !Number.isSafeInteger(saved.offset)
    || saved.offset < 0 || saved.offset > stat.size || stat.size < (saved.size ?? 0)) return false;
  const changed = saved.size !== stat.size || saved.mtimeMs !== stat.mtimeMs || saved.ctimeMs !== stat.ctimeMs;
  if (saved.size === stat.size && changed) return false;
  if (changed && saved.head && cursorWitness(fd, Math.min(saved.offset, 64)) !== saved.head) return false;
  return cursorWitness(fd, saved.offset) === saved.witness;
}

export function isWorkTranscriptContentRow(row) {
  return (row?.type === 'user' || row?.type === 'assistant')
    && row.isSidechain !== true && row.isSidechain !== 'true'
    && row.isMeta !== true && row.isMeta !== 'true';
}

function parseWorkTranscriptRow(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** Scan complete rows in bounded chunks, retaining at most one raw row. */
function* scanWorkTranscriptRows(fd, size, offset, needsDelimiter) {
  let parts = [];
  let length = 0;
  for (let position = offset; position < size;) {
    const chunk = readTranscriptBytes(fd, position, Math.min(WORK_TRANSCRIPT_SCAN_CHUNK, size - position));
    if (!chunk.length) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      length += end - start;
      if (length > WORK_TRANSCRIPT_WINDOW) parts = [];
      else if (end > start) parts.push(chunk.subarray(start, end));
      if (newline < 0) break;

      const bytes = length <= WORK_TRANSCRIPT_WINDOW
        ? (parts.length === 1 ? parts[0] : Buffer.concat(parts, length))
        : null;
      const separator = needsDelimiter && bytes !== null && isWhitespacePrefix(bytes, bytes.length);
      needsDelimiter = false;
      yield { line: bytes?.toString('utf8') ?? null, offset: position + newline + 1, length, separator, needsDelimiter };
      parts = [];
      length = 0;
      start = newline + 1;
    }
    position += chunk.length;
  }
  if (length && length <= WORK_UNTERMINATED_ROW_LIMIT) {
    const bytes = Buffer.concat(parts, length);
    if (isCompleteTranscriptRow(bytes)) {
      yield { line: bytes.toString('utf8'), offset: size, length, needsDelimiter: true };
    }
  }
}

function makeWorkByteCursor(fd, stat, offset, needsDelimiter) {
  const after = fs.fstatSync(fd);
  if (after.size < stat.size || (after.size === stat.size
    && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs))) return null;
  return { dev: stat.dev, ino: stat.ino, offset,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    head: cursorWitness(fd, Math.min(offset, 64)), witness: cursorWitness(fd, offset),
    ...(needsDelimiter ? { needsDelimiter: true } : {}) };
}

/** Drain incremental backlogs one turn at a time without dropping earlier turns. */
function* readWorkBacklog(fd, stat, offset, startLine, needsDelimiter, { isPromptRow, isReviewCopyRow }) {
  const scan = () => scanWorkTranscriptRows(fd, stat.size, offset, needsDelimiter);
  // A review marker at the end suppresses the entire fork, including earlier
  // turns. Check before yielding anything that can be appended to history.
  let reviewCopy = false;
  for (const row of scan()) {
    if (row.line !== null && isReviewCopyRow(parseWorkTranscriptRow(row.line))) {
      reviewCopy = true;
      break;
    }
  }

  let parsed = [];
  let promptBytes = 0;
  let retainedBytes = 0;
  let contentTruncated = false;
  let endLine = startLine;
  let endOffset = offset;
  let endNeedsDelimiter = needsDelimiter;

  const batch = () => {
    const byteCursor = makeWorkByteCursor(fd, stat, endOffset, endNeedsDelimiter);
    return byteCursor && { parsed, endLine, byteCursor, reason: 'incremental', contentTruncated };
  };

  for (const raw of scan()) {
    const row = reviewCopy || raw.line === null ? null : parseWorkTranscriptRow(raw.line);
    const content = isWorkTranscriptContentRow(row);
    if (content && isPromptRow(row)) {
      if (parsed.length || contentTruncated) {
        const ready = batch();
        if (!ready) return;
        yield ready;
      }
      parsed = [];
      promptBytes = raw.length;
      retainedBytes = 0;
      contentTruncated = false;
    }
    if (content) {
      if (retainedBytes + raw.length > WORK_TRANSCRIPT_WINDOW) {
        // Preserve the prompt and favor the latest responses in a single
        // oversized turn. Mark events derived from the reduced content.
        parsed = promptBytes ? parsed.slice(0, 1) : [];
        retainedBytes = promptBytes;
        contentTruncated = true;
      }
      if (retainedBytes + raw.length <= WORK_TRANSCRIPT_WINDOW) {
        parsed.push(row);
        retainedBytes += raw.length;
      }
    } else if (raw.line === null && !reviewCopy) {
      contentTruncated = true;
    }
    if (!raw.separator) endLine++;
    endOffset = raw.offset;
    endNeedsDelimiter = raw.needsDelimiter;
  }

  // Keep the last turn together when its final row is still being written.
  if (endOffset > offset && (endOffset === stat.size || !parsed.length)) {
    const ready = batch();
    if (ready) yield ready;
  }
}

/** The Work processors keep their legacy line counts but read only unread bytes. */
export function* readTranscriptBatches(agentId, transcriptPath, sessionId, classifiers) {
  let fd;
  try {
    // Keep nonblocking protection for FIFOs on POSIX. Windows needs only O_RDONLY.
    const nonblocking = process.platform === 'win32' ? 0 : (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | nonblocking);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return;
    const record = loadLineRecord(agentId, sessionId);
    const count = record.last_line_count;
    const saved = record.byte_cursor;
    let offset = 0;
    let startLine = 0;
    let reason = 'missing-cursor';
    let migrated = false;
    let needsDelimiter = false;
    if (record.session_id && record.session_id !== sessionId) {
      reason = 'session-changed';
    } else if (record.transcript_path && record.transcript_path !== transcriptPath) {
      reason = 'transcript-changed';
    } else if (Number.isSafeInteger(count) && count >= 0) {
      if (saved) {
        if (matchesByteCursor(fd, stat, saved)) {
          offset = saved.offset;
          needsDelimiter = saved.needsDelimiter === true;
          migrated = saved.size === undefined;
          startLine = count;
          reason = 'incremental';
        } else {
          reason = 'truncated';
        }
      } else {
        const legacyOffset = offsetAtLine(fd, stat.size, count);
        if (legacyOffset) {
          offset = legacyOffset.offset;
          needsDelimiter = legacyOffset.needsDelimiter;
          startLine = count;
          reason = 'incremental';
          migrated = true;
        } else {
          reason = 'truncated';
        }
      }
    }

    let clipped = false;
    if (stat.size - offset > WORK_TRANSCRIPT_WINDOW) {
      if (reason === 'incremental') {
        yield* readWorkBacklog(fd, stat, offset, startLine, needsDelimiter, classifiers);
        return;
      }
      const tail = bootstrapTailStart(fd, stat.size, offset, startLine, needsDelimiter);
      if (!tail) {
        logDebug(agentId, 'Work transcript recovery is waiting for a line boundary');
        return;
      }
      logDebug(agentId, `Work transcript recovery (${reason}): skipped ${tail.offset - offset} bytes and ${tail.lines - startLine} lines before bounded tail`);
      offset = tail.offset;
      startLine = tail.lines;
      needsDelimiter = false;
      clipped = true;
    }
    let bytes = readTranscriptBytes(fd, offset, stat.size - offset);
    const separator = needsDelimiter ? bytes.indexOf(10) : -1;
    const consumedSeparator = separator >= 0 && isWhitespacePrefix(bytes, separator);
    if (consumedSeparator) {
      offset += separator + 1;
      bytes = bytes.subarray(separator + 1);
      needsDelimiter = false;
    }
    let complete = bytes.lastIndexOf(10) + 1;
    if (complete < bytes.length && isCompleteTranscriptRow(bytes.subarray(complete))) {
      complete = bytes.length;
      needsDelimiter = true;
    } else if (complete) {
      needsDelimiter = false;
    }
    if (reason === 'incremental' && complete && complete < bytes.length) {
      yield* readWorkBacklog(fd, stat, offset, startLine, needsDelimiter, classifiers);
      return;
    }
    const endOffset = offset + complete;
    if (!complete && !migrated && !consumedSeparator && !clipped) return;
    const byteCursor = makeWorkByteCursor(fd, stat, endOffset, needsDelimiter);
    if (!byteCursor) return;
    if (!complete) {
      updateLineRecord(agentId, transcriptPath, sessionId, startLine, byteCursor, reason !== 'incremental');
      return;
    }
    const textEnd = bytes[complete - 1] === 10 ? complete - 1 : complete;
    const lines = bytes.toString('utf8', 0, textEnd).split('\n');
    const endLine = startLine + lines.length;
    yield { lines: lines.map(line => line.trim()).filter(Boolean), endLine, byteCursor, reason, clipped };
  } catch (error) {
    if (error?.code !== 'ENOENT') logDebug(agentId, `Work transcript read failed: ${String(error)}`);
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function processWorkTranscript(agentId, logPrefix, transcriptPath, sessionId, classifiers, processRows) {
  // Concurrent Stops must not append the same batch or rewind its cursor.
  const lock = `${sessionLineRecordFile(agentId, sessionId)}.process.lock`;
  const result = withSyncFileLock(lock, 15_000, 300_000, () => {
    for (const batch of readTranscriptBatches(agentId, transcriptPath, sessionId, classifiers)) {
      const parsed = batch.parsed ?? batch.lines.map(parseWorkTranscriptRow).filter(Boolean);
      if (batch.clipped && !parsed.some(row => isWorkTranscriptContentRow(row) && classifiers.isPromptRow(row))) {
        parsed.length = 0;
      }
      const records = parsed.length ? processRows(parsed, batch.reason).filter(Boolean) : [];
      if (batch.contentTruncated) {
        logDebug(agentId, `Work transcript backlog: oversized content before line ${batch.endLine}`);
        for (const record of records) record['agent.transcript.content_truncated'] = true;
      }
      if (!appendRowsToHistory(agentId, logPrefix, records.map(record => JSON.stringify(record)))) break;
      if (!updateLineRecord(agentId, transcriptPath, sessionId, batch.endLine, batch.byteCursor, batch.reason !== 'incremental')) break;
    }
  });
  if (!result.acquired) logDebug(agentId, 'Work transcript is already being processed');
}

export function sliceTranscriptLines(allLines, startLine, endLine) {
  const lines = [];
  for (let i = startLine; i < endLine && i < allLines.length; i++) {
    const trimmed = allLines[i].trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

export function readTranscriptLines(transcriptPath, startLine, endLine) {
  const { allLines } = readTranscriptSnapshotLines(transcriptPath);
  return sliceTranscriptLines(allLines, startLine, endLine);
}

export function parseTranscriptLine(line, agentId, runtimeConfig, turnId) {
  try {
    const parsed = JSON.parse(line);
    return normalizeTranscriptRecord(parsed, agentId, runtimeConfig, turnId);
  } catch {
    return null;
  }
}

export function normalizeTranscriptRecord(record, agentId, runtimeConfig, turnId) {
  if (agentId === 'qoder-cli' || agentId === 'qoder-work' || agentId === 'qoder' || agentId === 'qoder-cn') {
    return buildQoderHookRecord(record, { agentId, runtimeConfig, turnId });
  }
  return record;
}

// --- History file -----------------------------------------------------------

export function getHistoryLogFile(agentId, logPrefix) {
  const day = getLocalDateString();
  const historyDir = path.join(LOONGSUITE_PILOT_LOGS_BASE_DIR, agentId, 'history');
  return path.join(historyDir, `${logPrefix}-${day}.jsonl`);
}

export function appendRowsToHistory(agentId, logPrefix, rows) {
  try {
    rows = filterWorkspaceJsonLines(rows, agentId);
    if (!rows.length) return true;
    const logFile = getHistoryLogFile(agentId, logPrefix);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const result = withSyncFileLock(`${logFile}.lock`, 15_000, 10_000, () => {
      fs.appendFileSync(logFile, rows.join('\n') + '\n', 'utf-8');
      return true;
    });
    if (!result.acquired) {
      logDebug(agentId, `ERROR appending rows to history: timed out waiting for ${logFile}.lock`);
      return false;
    }
    logDebug(agentId, `Appended ${rows.length} rows to ${logFile}`);
    return true;
  } catch (e) {
    logDebug(agentId, `ERROR appending rows to history: ${e.message}`);
    return false;
  }
}

// --- Stdin helper -----------------------------------------------------------

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  // decodePayload 负责去 UTF-8 BOM + 修复 Cursor/Qoder 中文 UTF-8→GBK 双重编码。
  // (原先由 PowerShell hook wrapper 用 .NET 完成,已移入 node 以兼容 WDAC 受限语言模式)
  return decodePayload(Buffer.concat(chunks));
}

export async function parseStdinPayload(agentId) {
  const raw = await readStdin();
  process.stdout.write('{}\n');

  if (!raw || !raw.trim()) return null;

  logDebug(agentId, `stdin payload: ${raw.length} bytes`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    logDebug(agentId, `Failed to parse stdin JSON: ${e.message}`);
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  logDebug(agentId, `event: ${payload.hook_event_name || 'unknown'}, session: ${payload.session_id || ''}`);
  logDebug(agentId, `payload keys: ${Object.keys(payload).join(', ')}`);

  if (payload.stop_hooks_active) {
    logDebug(agentId, 'stop_hooks_active=true, exiting to avoid recursion');
    return null;
  }

  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || payload.conversation_id || '';

  if (!transcriptPath || !sessionId) {
    logDebug(agentId, 'No transcript_path or session_id in payload');
    return null;
  }

  if (!fs.existsSync(transcriptPath)) {
    logDebug(agentId, `Transcript file not found: ${transcriptPath}`);
    return null;
  }

  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
  const extra = payload.extra && typeof payload.extra === 'object' && !Array.isArray(payload.extra)
    ? payload.extra
    : undefined;
  return { transcriptPath, sessionId, cwd, extra };
}

// --- Re-export normalizer utilities -----------------------------------------

export { loadHookRuntimeConfig };
