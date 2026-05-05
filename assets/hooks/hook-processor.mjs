#!/usr/bin/env node
/**
 * Shared hook transcript forwarder for loongsuite-pilot.
 *
 * Incrementally reads new lines from a transcript file and appends them
 * to daily-rotated JSONL history logs. Tracks line offsets per transcript
 * to avoid duplicate processing.
 *
 * Usage:
 *   hook-processor.mjs --agent-id <id> [--log-prefix <prefix>]
 *
 *   --agent-id    Required. Determines the history directory:
 *                   ~/.loongsuite-pilot/logs/{agent-id}/history/
 *   --log-prefix  Optional. JSONL file name prefix (defaults to agent-id).
 *                   e.g. --log-prefix cursor → cursor-2026-04-29.jsonl
 *
 * Stdin:
 *   JSON payload from the hook event, must contain:
 *     - transcript_path: path to the transcript JSONL file
 *     - session_id (or conversation_id): session identifier
 *
 * Called by cursor-loongpilot-hook.sh and qoder-loongpilot-hook.sh.
 * Fail-open: errors are logged locally and never block the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ENABLE_LOGGING = true;
const HOOKS_DIR = path.dirname(new URL(import.meta.url).pathname);
const LOONGPILOT_LOGS_BASE_DIR = (() => {
  const configured = process.env.LOONGPILOT_DATA_DIR || process.env.LOONGSUITE_PILOT_DATA_DIR;
  return path.join(configured || path.join(os.homedir(), '.loongsuite-pilot'), 'logs');
})();

// --- CLI argument parsing ---------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let agentId = '';
  let logPrefix = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-id' && i + 1 < args.length) { agentId = args[++i]; }
    else if (args[i] === '--log-prefix' && i + 1 < args.length) { logPrefix = args[++i]; }
  }
  if (!agentId) {
    process.stderr.write('hook-processor.mjs: --agent-id is required\n');
    process.exit(1);
  }
  return { agentId, logPrefix: logPrefix || agentId };
}

// --- Logging ----------------------------------------------------------------

let _logFile = '';
function getLogFile(agentId) {
  if (!_logFile) _logFile = path.join(HOOKS_DIR, `${agentId}_hook.log`);
  return _logFile;
}

function logDebug(agentId, message) {
  if (!ENABLE_LOGGING) return;
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(getLogFile(agentId), `[${ts}] ${message}\n`, 'utf-8');
  } catch { /* best-effort */ }
}

// --- Line record persistence (per agent-id) ---------------------------------

function lineRecordFile(agentId) {
  return path.join(HOOKS_DIR, `.line_records.${agentId}.json`);
}

function loadLineRecords(agentId) {
  try {
    const f = lineRecordFile(agentId);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLineRecords(agentId, records) {
  try {
    const f = lineRecordFile(agentId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(records, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function updateLineRecord(agentId, transcriptPath, sessionId, endLine) {
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

function getTranscriptLineCount(transcriptPath) {
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

function getLineRange(agentId, transcriptPath, sessionId) {
  const records = loadLineRecords(agentId);
  const record = records[transcriptPath] || {};
  let lastCount = record.last_line_count || 0;
  const recordedSession = record.session_id || '';

  const currentCount = getTranscriptLineCount(transcriptPath);

  if (recordedSession && recordedSession !== sessionId) {
    logDebug(agentId, `Session changed: ${recordedSession} -> ${sessionId}, reset to 0`);
    lastCount = 0;
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
  }

  logDebug(agentId, `Range: ${lastCount} -> ${currentCount}`);
  return [lastCount, currentCount];
}

function readTranscriptLines(transcriptPath, startLine, endLine) {
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

function parseTranscriptLine(line) {
  try {
    return JSON.stringify(JSON.parse(line));
  } catch {
    return null;
  }
}

// --- History file -----------------------------------------------------------

function getHistoryLogFile(agentId, logPrefix) {
  const day = new Date().toISOString().slice(0, 10);
  const historyDir = path.join(LOONGPILOT_LOGS_BASE_DIR, agentId, 'history');
  return path.join(historyDir, `${logPrefix}-${day}.jsonl`);
}

function appendRowsToHistory(agentId, logPrefix, rows) {
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

// --- Core pipeline ----------------------------------------------------------

function uploadLines(agentId, logPrefix, transcriptPath, startLine, endLine, sessionId) {
  if (startLine >= endLine) return true;

  const expectedCount = endLine - startLine;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines from ${transcriptPath} (range: ${startLine}-${endLine}, expected: ${expectedCount})`);

  if (lines.length < expectedCount) {
    logDebug(agentId, `Warning: Expected ${expectedCount} lines but only read ${lines.length}`);
  }
  if (!lines.length) return true;

  const rowsToAppend = [];
  for (const line of lines) {
    const row = parseTranscriptLine(line);
    if (row) rowsToAppend.push(row);
  }

  const success = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (success) {
    logDebug(agentId, `Successfully appended ${rowsToAppend.length} rows from ${transcriptPath}`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
  } else {
    logDebug(agentId, `Failed to append rows from ${transcriptPath}`);
  }
  return success;
}

// --- Stdin / entry point ----------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const { agentId, logPrefix } = parseArgs();

  const raw = await readStdin();
  process.stdout.write('{}\n');

  if (!raw || !raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    logDebug(agentId, 'Failed to parse stdin JSON');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  logDebug(agentId, `event: ${payload.hook_event_name || 'unknown'}, session: ${payload.session_id || ''}`);

  if (payload.stop_hooks_active) {
    logDebug(agentId, 'stop_hooks_active=true, exiting to avoid recursion');
    return;
  }

  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || payload.conversation_id || '';

  if (!transcriptPath || !sessionId) {
    logDebug(agentId, 'No transcript_path or session_id in payload');
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    logDebug(agentId, `Transcript file not found: ${transcriptPath}`);
    return;
  }

  const range = getLineRange(agentId, transcriptPath, sessionId);
  if (!range) return;

  const [startLine, endLine] = range;
  uploadLines(agentId, logPrefix, transcriptPath, startLine, endLine, sessionId);
}

main().catch((e) => {
  // Fail-open: never block the caller.
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    fs.appendFileSync(path.join(HOOKS_DIR, 'hook_processor_error.log'), `[${ts}] ${e.message}\n`, 'utf-8');
  } catch { /* ignore */ }
});
