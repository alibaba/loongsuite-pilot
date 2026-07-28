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

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyHookContentPolicy,
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

const CLI_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}/;

function inferVariant(events) {
  for (const ev of events) {
    if (ev.cursor_version && CLI_VERSION_PATTERN.test(ev.cursor_version)) return 'cursor-cli';
  }
  return 'cursor';
}

function compactJournal(allEvents, consumedConversationIds) {
  const pendingTurnConvIds = new Set();
  const remaining = [];
  for (const ev of allEvents) {
    if (consumedConversationIds.has(ev.conversation_id)) continue;
    if (ev.hook_event === 'beforeSubmitPrompt') pendingTurnConvIds.add(ev.conversation_id);
  }
  for (const ev of allEvents) {
    if (consumedConversationIds.has(ev.conversation_id)) continue;
    if (pendingTurnConvIds.has(ev.conversation_id)) remaining.push(ev);
  }
  rewriteJournal(remaining, allEvents);
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

function injectSkillRecords(records, skills, runtimeConfig = {}) {
  // Skill-to-step alignment is best-effort: attach detected reads to the first
  // assembled LLM response. Cursor's assemblers synthesize a response even for
  // thought-only and implicit tool steps, so never attach output to a request.
  const targetLlmIdx = records.findIndex(r => r['event.name'] === 'llm.response');
  if (targetLlmIdx < 0) return;

  // Generate each call ID once so the LLM output, tool.call, and tool.result
  // records all describe the same synthetic tool invocation.
  const skillEntries = skills.map(skill => ({
    skill,
    toolCallId: crypto.randomUUID(),
  }));

  // Append canonical Read tool_call entries to the first LLM response.
  const llmRecord = records[targetLlmIdx];
  const outputMsgs = Array.isArray(llmRecord['gen_ai.output.messages'])
    ? llmRecord['gen_ai.output.messages']
    : [];

  let assistantMsg = outputMsgs.find(m => m.role === 'assistant');
  if (!assistantMsg) {
    assistantMsg = { role: 'assistant', parts: [] };
    outputMsgs.push(assistantMsg);
  }
  if (!Array.isArray(assistantMsg.parts)) assistantMsg.parts = [];

  for (const { skill, toolCallId } of skillEntries) {
    assistantMsg.parts.push({
      type: 'tool_call',
      id: toolCallId,
      name: 'Read',
      arguments: { path: skill.skillPath },
    });
  }
  llmRecord['gen_ai.output.messages'] = outputMsgs;
  records[targetLlmIdx] = applyPolicy(llmRecord, runtimeConfig);

  // Create tool.call + tool.result record pairs for each skill read
  const insertRecords = [];
  const baseTime = BigInt(llmRecord.time_unix_nano);
  const baseObservedTime = BigInt(
    llmRecord.observed_time_unix_nano ?? llmRecord.time_unix_nano
  );
  for (let index = 0; index < skillEntries.length; index++) {
    const { skill, toolCallId } = skillEntries[index];
    const callOffset = BigInt(index * 2 + 1);
    const resultOffset = callOffset + 1n;
    const baseFields = {
      trace_id: llmRecord.trace_id,
      'gen_ai.session.id': llmRecord['gen_ai.session.id'],
      'gen_ai.turn.id': llmRecord['gen_ai.turn.id'],
      'gen_ai.step.id': llmRecord['gen_ai.step.id'] || 'step_1',
      'gen_ai.agent.type': llmRecord['gen_ai.agent.type'],
      'user.id': llmRecord['user.id'],
    };

    // tool.call
    insertRecords.push(applyPolicy({
      ...baseFields,
      time_unix_nano: String(baseTime + callOffset),
      observed_time_unix_nano: String(baseObservedTime + callOffset),
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.tool.call.arguments': { path: skill.skillPath },
      'gen_ai.skill.name': skill.skillName,
      'agent.cursor.skill_detection_source': 'transcript_post_assembly',
    }, runtimeConfig));

    // tool.result
    insertRecords.push(applyPolicy({
      ...baseFields,
      time_unix_nano: String(baseTime + resultOffset),
      observed_time_unix_nano: String(baseObservedTime + resultOffset),
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.skill.name': skill.skillName,
      'agent.cursor.skill_detection_source': 'transcript_post_assembly',
    }, runtimeConfig));
  }

  // Insert after the first LLM response.
  records.splice(targetLlmIdx + 1, 0, ...insertRecords);
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

      // ─── Deferred-stop for Cursor CLI ───
      // Cursor CLI fires stop BEFORE afterAgentResponse. If there's a prompt but
      // no response yet for this conversation, defer assembly until the late
      // response arrives. IDE sessions always assemble immediately (abort/error
      // scenarios must not lose data).
      const convId = internalEvent.conversation_id;
      const variant = inferVariant(allEvents);
      const hasResponse = allEvents.some(e =>
        e.hook_event === 'afterAgentResponse' && e.conversation_id === convId
      );
      if (variant === 'cursor-cli' && !hasResponse) {
        // defer — afterAgentResponse handler will trigger assembly
        writeEmptyResponse();
        return;
      }

      const runtimeConfig = loadHookRuntimeConfig(dataDir);
      let records;
      let consumedConversationIds;
      let assembledFromTranscript = false;

      // On Windows: use transcript as source of truth for text content.
      // This bypasses GB18030 codepage corruption of hook payload text.
      if (process.platform === 'win32' && internalEvent.transcript_path) {
        const transcriptRecords = buildCursorRecordsFromTranscript(
          internalEvent.transcript_path,
          allEvents,
          { runtimeConfig, stopConversationId: convId }
        );
        if (transcriptRecords && transcriptRecords.length > 0) {
          records = transcriptRecords;
          consumedConversationIds = new Set([convId]);
          assembledFromTranscript = true;
        }
      }

      // Fallback: use hook-event-driven assembleTurn (Mac/Linux or transcript unavailable)
      if (!records) {
        const result = assembleTurn(allEvents, {
          runtimeConfig,
          variant,
          stopConversationId: convId,
          transcriptPath: internalEvent.transcript_path,
        });
        records = result.records;
        consumedConversationIds = result.consumedConversationIds;
      }

      // ─── Post-assembly: Skill Usage Detection from Transcript ───
      try {
        const transcriptPathForSkill = internalEvent.transcript_path;
        const promptForSkill = allEvents.find(e =>
          e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === convId
        );
        if (transcriptPathForSkill && promptForSkill?.prompt && records.length > 0) {
          const { detectSkillFromTranscript } = await import('./cursor/skill-detector.mjs');
          const detectedSkills = detectSkillFromTranscript(transcriptPathForSkill, promptForSkill.prompt);
          // The Windows transcript assembler already materializes transcript
          // tool_use entries. Only compensate paths assembled from hook events.
          if (detectedSkills && detectedSkills.length > 0 && !assembledFromTranscript) {
            injectSkillRecords(records, detectedSkills, runtimeConfig);
          }
        }
      } catch { /* best-effort skill detection — never block output */ }

      if (records.length > 0) {
        const day = localDateString(now);
        const historyFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
        await appendBatchJsonl(historyFile, records);
      }

      compactJournal(allEvents, consumedConversationIds);
    } catch (err) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'assemble',
        'error.type': 'assemble_failed',
        'error.message': err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Deferred-stop compensation: assemble when late response arrives ───
  // When stop was deferred (no response yet), afterAgentResponse triggers assembly.
  if (internalEvent.hook_event === 'afterAgentResponse') {
    try {
      const allEvents = readAllEvents();
      const convId = internalEvent.conversation_id;
      const hasStop = allEvents.some(e =>
        e.hook_event === 'stop' && e.conversation_id === convId
      );
      if (hasStop) {
        const runtimeConfig = loadHookRuntimeConfig(dataDir);
        const variant = inferVariant(allEvents);
        // Note: transcriptPath is deliberately omitted here — assembleTurn falls
        // back to stopEvent?.transcript_path internally. Passing internalEvent's
        // transcriptPath (from afterAgentResponse) would be incorrect.
        const result = assembleTurn(allEvents, {
          runtimeConfig,
          variant,
          stopConversationId: convId,
        });

        if (result.records.length > 0) {
          const day = localDateString(now);
          const historyFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
          await appendBatchJsonl(historyFile, result.records);
        }

        compactJournal(allEvents, result.consumedConversationIds);
      }
    } catch (err) {
      await appendErrorJsonl(dataDir, now, {
        stage: 'deferred_assemble',
        'error.type': 'deferred_assemble_failed',
        'error.message': err instanceof Error ? err.message : String(err),
      });
    }
  }

  writeEmptyResponse();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(async err => {
    await appendErrorJsonl(resolveDataDir(), new Date(), {
      stage: 'runtime',
      'error.type': 'unhandled_exception',
      'error.message': err instanceof Error ? err.message : String(err),
    });
    writeEmptyResponse();
  });
}

export { injectSkillRecords };
