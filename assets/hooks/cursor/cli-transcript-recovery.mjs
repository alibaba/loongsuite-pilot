// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSyncFileLock } from '../shared/sync-file-lock.mjs';

const MAX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_ROWS_PER_TURN = 64;
const MAX_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function readTail(file, maxBytes, requireOwner = false) {
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
    const details = fs.fstatSync(fd);
    const uid = process.geteuid?.();
    if (!details.isFile() || (requireOwner && (details.nlink !== 1 || (uid != null && details.uid !== uid)))) {
      throw new Error('Cursor collection source is not an owned regular file');
    }
    const start = Math.max(0, details.size - maxBytes);
    const buffer = Buffer.alloc(details.size - start);
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    if (length !== buffer.length) throw new Error('Cursor collection source changed during read');
    const skip = start === 0 ? 0 : buffer.indexOf(0x0a) + 1;
    const text = start > 0 && skip === 0 ? '' : buffer.toString('utf8', skip);
    return { text, offset: start + skip, truncated: start > 0 };
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function officialTranscriptPath(event) {
  const { session_id: sessionId, transcript_path: transcriptPath } = event;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  const root = path.join(fs.realpathSync(os.homedir()), '.cursor', 'projects');
  const resolved = fs.realpathSync(transcriptPath);
  const relative = path.relative(root, resolved);
  const parts = relative.split(path.sep);
  if (parts.length !== 4 || parts[0] === '..' || path.isAbsolute(relative)) return null;
  if (parts[1] !== 'agent-transcripts' || parts[2] !== sessionId || parts[3] !== `${sessionId}.jsonl`) return null;
  return resolved;
}

function isUserPrompt(row) {
  return row.role === 'user' && Array.isArray(row.message?.content)
    && row.message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
}

/** Read only the last completed native turn. Cursor may replace a previous
 * turn_ended marker on resume, so the last user row is the turn's start. */
export function readCursorCliCompletedTurn(event) {
  try {
    const transcript = officialTranscriptPath(event);
    if (!transcript || event.reason !== 'completed') return null;
    const endMs = Date.parse(event._journal_ts);
    if (!Number.isFinite(endMs) || !Number.isFinite(event.duration_ms) || event.duration_ms <= 0
      || event.duration_ms > 24 * 60 * 60 * 1000) return null;
    const { text, offset } = readTail(transcript, MAX_TRANSCRIPT_TAIL_BYTES, true);
    const content = text.trimEnd();
    if (!content) return null;
    const terminalIndex = content.lastIndexOf('\n');
    const terminal = JSON.parse(content.slice(terminalIndex + 1));
    if (terminal?.type !== 'turn_ended' || terminal.status !== 'success') return null;

    const entries = [];
    let end = terminalIndex;
    while (end > 0 && entries.length < MAX_TRANSCRIPT_ROWS_PER_TURN) {
      const start = content.lastIndexOf('\n', end - 1) + 1;
      const entry = JSON.parse(content.slice(start, end));
      if (!entry || entry.type === 'turn_ended') return null;
      entries.push(entry);
      if (isUserPrompt(entry)) {
        const promptOffset = offset + Buffer.byteLength(content.slice(0, start));
        const transcriptKey = crypto.createHash('sha256').update(`${transcript}\0${promptOffset}`).digest('hex').slice(0, 24);
        return {
          entries: entries.reverse(),
          turnId: `${event.session_id}:transcript:${transcriptKey}`,
          startMs: endMs - event.duration_ms,
          endMs,
        };
      }
      end = start - 1;
    }
    return null;
  } catch {
    return null;
  }
}

function historyAlreadyCoversTurn(file, conversationId, turn) {
  let tail;
  try {
    tail = readTail(file, MAX_HISTORY_TAIL_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  let earliest = Infinity;
  for (const line of tail.text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const atMs = Number(row.time_unix_nano) / NANOSECONDS_PER_MILLISECOND;
    if (Number.isFinite(atMs)) earliest = Math.min(earliest, atMs);
    if (row['gen_ai.session.id'] !== conversationId) continue;
    if (row['gen_ai.turn.id'] === turn.turnId && row['gen_ai.turn.end'] === true) return true;
    // Preserve normal Hook collection when it completed a turn in this session
    // before the end callback arrived. Earlier resumed turns are out of window.
    if (!row['agent.cursor.transcript_recovery'] && row['event.name'] === 'llm.response'
      && atMs >= turn.startMs && atMs <= turn.endMs) return true;
  }
  // When the relevant window falls outside the bounded tail, defer recovery.
  return tail.truncated && earliest > turn.startMs;
}

export function appendCursorCliRecoveredTurn(file, previousFile, records, event, turn) {
  const result = withSyncFileLock(`${file}.recovery.lock`, 100, 30_000, () => {
    if (historyAlreadyCoversTurn(file, event.conversation_id, turn)
      || (previousFile && historyAlreadyCoversTurn(previousFile, event.conversation_id, turn))) return;
    const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    // An incomplete final line should remain separate from this batch.
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR
      | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(file, flags, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Cursor history file');
      const last = Buffer.alloc(1);
      if (stat.size > 0) fs.readSync(fd, last, 0, 1, stat.size - 1);
      fs.appendFileSync(fd, stat.size > 0 && last[0] !== 0x0a ? '\n' + text : text);
    } finally {
      fs.closeSync(fd);
    }
  });
  if (!result.acquired) throw new Error('Cursor transcript recovery history lock unavailable');
}
