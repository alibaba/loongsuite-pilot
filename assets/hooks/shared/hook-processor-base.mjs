/**
 * Shared infrastructure for hook transcript processors.
 * Provides file I/O, offset tracking, logging, and common utilities
 * used by both qoder-hook-processor.mjs and qoderwork-hook-processor.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildQoderHookRecord,
  loadHookRuntimeConfig,
} from '../agent-event-normalizer.mjs';

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

function saveSessionLineRecord(agentId, sessionId, record) {
  const file = sessionLineRecordFile(agentId, sessionId);
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    }
    return false;
  }
}

function migrateAggregateLineRecords(agentId) {
  const sources = [
    aggregateLineRecordFile(agentId),
    deployedLegacyLineRecordFile(agentId),
  ];

  for (const source of sources) {
    const records = readJsonObject(source);
    if (!records) continue;

    let migratedAll = true;
    for (const [transcriptPath, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        migratedAll = false;
        continue;
      }
      const sessionId = typeof value.session_id === 'string' ? value.session_id : '';
      if (!sessionId) {
        migratedAll = false;
        continue;
      }

      const target = sessionLineRecordFile(agentId, sessionId);
      if (fs.existsSync(target)) continue;
      const migrated = saveSessionLineRecord(agentId, sessionId, {
        ...value,
        session_id: sessionId,
        transcript_path: transcriptPath,
      });
      if (!migrated) migratedAll = false;
    }

    if (migratedAll) {
      try { fs.unlinkSync(source); } catch { /* best-effort migration cleanup */ }
    }
  }
}

export function loadLineRecord(agentId, sessionId) {
  if (!sessionId) return {};
  const file = sessionLineRecordFile(agentId, sessionId);
  const persisted = readJsonObject(file);
  if (persisted) return persisted;

  // Older releases stored every transcript in one per-agent JSON object,
  // either in the persistent state directory or beside the deployed hooks.
  // Split those maps lazily into independent session files so concurrent Stop
  // hooks for different sessions never overwrite each other's cursor.
  migrateAggregateLineRecords(agentId);
  return readJsonObject(file) || {};
}

export function updateLineRecord(agentId, transcriptPath, sessionId, endLine) {
  const record = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    last_line_count: endLine,
    updated_at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
  };
  const ok = saveSessionLineRecord(agentId, sessionId, record);
  if (ok) logDebug(agentId, `Updated record: ${transcriptPath} -> ${endLine} lines`);
  else logDebug(agentId, 'Warning: Failed to save line records');
  return ok;
}

// --- Transcript reading -----------------------------------------------------

export function getTranscriptLineCount(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return 0;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') count++;
    }
    if (content.length > 0 && content[content.length - 1] !== '\n') count++;
    return count;
  } catch {
    return 0;
  }
}

export function getLineRangeInfo(agentId, transcriptPath, sessionId) {
  const record = loadLineRecord(agentId, sessionId);
  const hasRecordedOffset = Number.isFinite(record.last_line_count)
    && record.last_line_count >= 0;
  let lastCount = hasRecordedOffset ? record.last_line_count : 0;
  const recordedSession = record.session_id || '';
  const recordedTranscript = record.transcript_path || '';
  let reason = hasRecordedOffset ? 'incremental' : 'missing-cursor';

  const currentCount = getTranscriptLineCount(transcriptPath);

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
 * Backward-compatible tuple API used by hook processors that do not need to
 * distinguish a normal incremental read from cursor recovery.
 */
export function getLineRange(agentId, transcriptPath, sessionId) {
  const info = getLineRangeInfo(agentId, transcriptPath, sessionId);
  return info ? [info.startLine, info.endLine] : null;
}

export function readTranscriptLines(transcriptPath, startLine, endLine) {
  const lines = [];
  try {
    if (!fs.existsSync(transcriptPath)) return lines;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const allLines = content.split('\n');
    for (let i = startLine; i < endLine && i < allLines.length; i++) {
      const trimmed = allLines[i].trim();
      if (trimmed) lines.push(trimmed);
    }
  } catch {
    // best-effort
  }
  return lines;
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
  if (!rows.length) return true;
  const logFile = getHistoryLogFile(agentId, logPrefix);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, rows.join('\n') + '\n', 'utf-8');
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
  let str = Buffer.concat(chunks).toString('utf-8');
  // Strip UTF-8 BOM — PowerShell 5.x adds BOM when piping strings to native commands
  if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
  return str;
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
  return { transcriptPath, sessionId, cwd };
}

// --- Re-export normalizer utilities -----------------------------------------

export { loadHookRuntimeConfig };
