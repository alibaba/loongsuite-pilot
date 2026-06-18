#!/usr/bin/env node
/**
 * Cursor hook processor for loongsuite-pilot.
 *
 * Stateful processor: each hook event is appended to an event journal.
 * On parent "stop", all journal events are assembled into canonical history
 * records with proper step division, subagent nesting, and trace ids.
 *
 * History JSONL is the sole formal data source for CursorHookInput.
 * Raw capture is behind LOONGSUITE_CURSOR_RAW_TRACE=1 env flag.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hashJson,
  loadHookRuntimeConfig,
  sanitizeObject,
} from './agent-event-normalizer.mjs';
import { toInternalEvent } from './cursor/source-event.mjs';
import { appendEvent, readAllEvents, rewriteJournal } from './cursor/event-journal.mjs';
import { assembleTurn } from './cursor/react-assembler.mjs';
import { buildCursorRecordsFromTranscript } from './cursor/transcript-assembler.mjs';

function resolveDataDir() {
  const configured = process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.loongsuite-pilot');
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function appendErrorJsonl(dataDir, now, fields) {
  const day = localDateString(now);
  const record = sanitizeObject({
    time: now.toISOString(),
    clientType: 'CursorHook',
    ...fields,
  }) || { time: now.toISOString(), clientType: 'CursorHook', stage: 'unknown' };
  const candidates = [
    path.join(dataDir, 'logs', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
    path.join(os.tmpdir(), 'loongsuite-pilot', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
  ];
  for (const filePath of candidates) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
      return;
    } catch {
      // best-effort
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  let str = Buffer.concat(chunks).toString('utf-8');
  if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
  return str;
}

async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function appendBatchJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(filePath, content, 'utf-8');
}

function writeEmptyResponse() {
  process.stdout.write('{}\n');
}

async function main() {
  const dataDir = resolveDataDir();
  const raw = await readStdin();
  if (!raw || raw.trim().length === 0) {
    writeEmptyResponse();
    return;
  }

  const now = new Date();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (firstErr) {
    // Cursor on Windows may insert spurious 0x3F (?) after closing quotes in JSON
    // events containing Chinese text (GB18030 codepage maps some chars to ?).
    // The ? appears after a closing " and before a structural char (, } ]):
    //   "value"?,  → "value",
    //   "value"?}  → "value"}
    if (process.platform === 'win32') {
      const repaired = raw
        .replace(/"?\?,/g, '",')   // "?, or ?, before comma
        .replace(/"?\?}/g, '"}')   // "?} or ?} before }
        .replace(/"?\?]/g, '"]');  // "?] or ?] before ]
      if (repaired !== raw) {
        try {
          payload = JSON.parse(repaired);
        } catch {
          // repair didn't help
        }
      }
    }
    if (!payload) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'parse',
        'error.type': 'invalid_json',
        'error.message': firstErr instanceof Error ? firstErr.message : String(firstErr),
        input_bytes: Buffer.byteLength(raw),
        input_sha256: hashJson(raw),
      });
      writeEmptyResponse();
      return;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'validate',
      'error.type': 'invalid_payload_root',
      'error.message': 'Expected JSON object root payload',
      input_bytes: Buffer.byteLength(raw),
      input_sha256: hashJson(raw),
    });
    writeEmptyResponse();
    return;
  }

  // Convert to internal event and append to journal
  const internalEvent = toInternalEvent(payload);
  try {
    appendEvent(internalEvent);
  } catch (err) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'journal_append',
      'error.type': 'journal_failed',
      'error.message': err instanceof Error ? err.message : String(err),
      hookEvent: internalEvent.hook_event,
    });
    writeEmptyResponse();
    return;
  }

  if (process.env.LOONGSUITE_CURSOR_RAW_TRACE === '1') {
    try {
      const rawFile = path.join(dataDir, 'logs', 'cursor', 'raw', 'cursor-raw-trace.jsonl');
      await appendJsonl(rawFile, { _captured_at: now.toISOString(), ...payload });
    } catch {
      // best-effort
    }
  }

  // On stop: assemble turn and write history
  if (internalEvent.hook_event === 'stop') {
    try {
      const allEvents = readAllEvents();

      // NOTE: preToolUse events may arrive after stop is processed due to Cursor's
      // parallel hook invocation. When this happens, tool.call/result records are
      // absent from the output — this is a known Cursor hook timing limitation.

      // Guard against duplicate stop events: if journal has no beforeSubmitPrompt
      // for this conversation, the turn was already processed — skip to avoid duplication.
      const hasPendingTurn = allEvents.some(e =>
        e.hook_event === 'beforeSubmitPrompt' &&
        e.conversation_id === internalEvent.conversation_id
      );
      if (!hasPendingTurn) {
        await appendErrorJsonl(dataDir, now, {
          stage: 'stop_guard',
          'error.type': 'info',
          'error.message': `skipped duplicate stop for conv=${internalEvent.conversation_id?.slice(0, 8)} (no pending beforeSubmitPrompt)`,
        });
        writeEmptyResponse();
        return;
      }

      const runtimeConfig = loadHookRuntimeConfig(dataDir);
      let records;
      let consumedConversationIds;

      // On Windows: use transcript as source of truth for text content.
      // This bypasses GB18030 codepage corruption of hook payload text.
      if (process.platform === 'win32' && internalEvent.transcript_path) {
        const transcriptRecords = buildCursorRecordsFromTranscript(
          internalEvent.transcript_path,
          allEvents,
          { runtimeConfig, stopConversationId: internalEvent.conversation_id }
        );
        if (transcriptRecords && transcriptRecords.length > 0) {
          records = transcriptRecords;
          consumedConversationIds = new Set([internalEvent.conversation_id]);
        }
      }

      // Fallback: use hook-event-driven assembleTurn (Mac/Linux or transcript unavailable)
      if (!records) {
        const result = assembleTurn(allEvents, {
          runtimeConfig,
          stopConversationId: internalEvent.conversation_id,
          transcriptPath: internalEvent.transcript_path,
        });
        records = result.records;
        consumedConversationIds = result.consumedConversationIds;
      }

      if (records.length > 0) {
        const day = localDateString(now);
        const historyFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
        await appendBatchJsonl(historyFile, records);
      }

      // Rewrite journal: keep only events that belong to a pending user turn
      // (has beforeSubmitPrompt but no stop yet). Drop everything else:
      // consumed parent, child sessions, subagent meta, and orphan delayed events.
      const pendingTurnConvIds = new Set();
      const remaining = [];
      for (const ev of allEvents) {
        if (consumedConversationIds.has(ev.conversation_id)) continue;
        if (ev.hook_event === 'beforeSubmitPrompt') pendingTurnConvIds.add(ev.conversation_id);
      }
      for (const ev of allEvents) {
        if (consumedConversationIds.has(ev.conversation_id)) continue;
        if (pendingTurnConvIds.has(ev.conversation_id)) remaining.push(ev);
        // else: orphan child/delayed event without a pending parent turn → drop
      }
      rewriteJournal(remaining, allEvents);
    } catch (err) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'assemble',
        'error.type': 'assemble_failed',
        'error.message': err instanceof Error ? err.message : String(err),
      });
    }
  }

  writeEmptyResponse();
}

main().catch(async err => {
  await appendErrorJsonl(resolveDataDir(), new Date(), {
    stage: 'runtime',
    'error.type': 'unhandled_exception',
    'error.message': err instanceof Error ? err.message : String(err),
  });
  writeEmptyResponse();
});
