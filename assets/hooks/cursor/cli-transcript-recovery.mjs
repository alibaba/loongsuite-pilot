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

function transcriptStamp(stat) {
  const uid = process.geteuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || (uid != null && stat.uid !== uid)) return undefined;
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
}

function readTail(file, maxBytes, expectedStamp) {
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
    const details = fs.fstatSync(fd);
    if (!details.isFile() || (expectedStamp && transcriptStamp(details) !== expectedStamp)) {
      throw new Error('Cursor collection source changed');
    }
    const start = Math.max(0, details.size - maxBytes);
    const buffer = Buffer.alloc(details.size - start);
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    if (length !== buffer.length || (expectedStamp && transcriptStamp(fs.fstatSync(fd)) !== expectedStamp)) {
      throw new Error('Cursor collection source changed during read');
    }
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

// Pin the original file version before policy evaluation or history writes can
// defer recovery. A resumed invocation may rewrite the end of this same file.
export function snapshotCursorCliTranscript(event) {
  try {
    const transcript = officialTranscriptPath(event);
    return transcript ? transcriptStamp(fs.lstatSync(transcript)) : undefined;
  } catch {
    return undefined;
  }
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
    if (!transcript || event.reason !== 'completed' || !event.transcript_stamp) return null;
    const endMs = Date.parse(event._journal_ts);
    if (!Number.isFinite(endMs) || !Number.isFinite(event.duration_ms) || event.duration_ms <= 0
      || event.duration_ms > 24 * 60 * 60 * 1000) return null;
    const { text, offset } = readTail(transcript, MAX_TRANSCRIPT_TAIL_BYTES, event.transcript_stamp);
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

function inspectHistory(file, conversationId, turn, emittedIds) {
  let tail;
  try {
    tail = readTail(file, MAX_HISTORY_TAIL_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'open';
    throw error;
  }
  let earliest = Infinity;
  const lines = tail.text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    // A short append may leave a valid JSON object without its newline.
    const covered = index === lines.length - 1 ? 'needs-newline' : 'covered';
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const atMs = Number(row.time_unix_nano) / NANOSECONDS_PER_MILLISECOND;
    if (Number.isFinite(atMs)) earliest = Math.min(earliest, atMs);
    if (row['gen_ai.session.id'] !== conversationId) continue;
    if (row['gen_ai.turn.id'] === turn.turnId) {
      if (row['gen_ai.turn.end'] === true) return covered;
      emittedIds.add(row['event.id']);
    }
    // Preserve normal Hook collection when it completed a turn in this session
    // before the end callback arrived. Earlier resumed turns are out of window.
    if (!row['agent.cursor.transcript_recovery'] && row['event.name'] === 'llm.response'
      && atMs >= turn.startMs && atMs <= turn.endMs) return covered;
  }
  // When the relevant window falls outside the bounded tail, defer recovery.
  return tail.truncated && earliest > turn.startMs ? 'uncertain' : 'open';
}

export function appendCursorCliRecoveredTurn(file, previousFile, records, event, turn) {
  const result = withSyncFileLock(`${file}.recovery.lock`, 100, 30_000, () => {
    const emittedIds = new Set();
    const current = inspectHistory(file, event.conversation_id, turn, emittedIds);
    if (current === 'covered') return true;
    const previous = previousFile && inspectHistory(previousFile, event.conversation_id, turn, emittedIds);
    if (previous === 'covered') return true;
    if (current === 'uncertain' || previous === 'uncertain' || previous === 'needs-newline') return false;
    // Complete a partially written batch without re-emitting its valid prefix.
    const pending = current === 'needs-newline' ? [] : records.filter(record => !emittedIds.has(record['event.id']));
    const text = pending.map(record => JSON.stringify(record) + '\n').join('');
    // An incomplete final line should remain separate from this batch.
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR
      | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(file, flags, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Cursor history file');
      const last = Buffer.alloc(1);
      if (stat.size > 0) fs.readSync(fd, last, 0, 1, stat.size - 1);
      const suffix = stat.size > 0 && last[0] !== 0x0a ? '\n' + text : text;
      if (suffix) fs.appendFileSync(fd, suffix);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  });
  if (!result.acquired) throw new Error('Cursor transcript recovery history lock unavailable');
  return result.value;
}
