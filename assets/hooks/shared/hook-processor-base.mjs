/**
 * Shared infrastructure for hook transcript processors.
 * Provides file I/O, offset tracking, logging, and common utilities
 * used by both qoder-hook-processor.mjs and qoderwork-hook-processor.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// --- Line record persistence (per agent-id) ---------------------------------

function lineRecordFile(agentId) {
  return path.join(LOONGSUITE_PILOT_DATA_DIR, 'state', 'hooks', `${agentId}-line-records.json`);
}

function legacyLineRecordFile(agentId) {
  return path.join(HOOKS_DIR, `.line_records.${agentId}.json`);
}

export function loadLineRecords(agentId) {
  try {
    const f = lineRecordFile(agentId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));

    // Before v1.0 the cursor lived beside the deployed hook scripts. That
    // directory can be replaced during deployment, so migrate it lazily into
    // the persistent data directory while old installations still have it.
    const legacy = legacyLineRecordFile(agentId);
    if (!fs.existsSync(legacy)) return {};
    const records = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    if (saveLineRecords(agentId, records)) {
      try { fs.unlinkSync(legacy); } catch { /* best-effort migration cleanup */ }
    }
    return records;
  } catch {
    return {};
  }
}

export function saveLineRecords(agentId, records) {
  let tmp = '';
  try {
    const f = lineRecordFile(agentId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
    return true;
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    }
    return false;
  }
}

export function updateLineRecord(agentId, transcriptPath, sessionId, endLine) {
  const records = loadLineRecords(agentId);
  records[transcriptPath] = {
    session_id: sessionId,
    last_line_count: endLine,
    updated_at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
  };
  const ok = saveLineRecords(agentId, records);
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
  const records = loadLineRecords(agentId);
  const record = records[transcriptPath] || {};
  const hasRecordedOffset = Number.isFinite(record.last_line_count)
    && record.last_line_count >= 0;
  let lastCount = hasRecordedOffset ? record.last_line_count : 0;
  const recordedSession = record.session_id || '';
  let reason = hasRecordedOffset ? 'incremental' : 'missing-cursor';

  const currentCount = getTranscriptLineCount(transcriptPath);

  if (recordedSession && recordedSession !== sessionId) {
    logDebug(agentId, `Session changed: ${recordedSession} -> ${sessionId}, reset to 0`);
    lastCount = 0;
    reason = 'session-changed';
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
