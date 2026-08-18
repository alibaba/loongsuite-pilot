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
import { decodePayload } from './shared/decode-payload.mjs';
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
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

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
  // decodePayload 去 BOM 并修复中文 UTF-8->GBK 双重编码(纠偏已从 PS 侧移入 node)。
  return decodePayload(Buffer.concat(chunks));
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

function findConversationResourceAttributes(events, conversationId) {
  const scopedEvents = events.filter(event => event.conversation_id === conversationId);
  const promptContext = scopedEvents.find(event =>
    event.hook_event === 'beforeSubmitPrompt' &&
    event.resource_attributes &&
    Object.keys(event.resource_attributes).length > 0
  );
  const contextEvent = promptContext || scopedEvents.find(event =>
    event.resource_attributes && Object.keys(event.resource_attributes).length > 0
  );
  return contextEvent?.resource_attributes || {};
}

function applyCursorCliResourceContext(records, events, conversationId, variant) {
  if (variant !== 'cursor-cli' || records.length === 0) return;
  // The journal is shared by Cursor Desktop and Cursor CLI. Re-check only the
  // current conversation so a pending CLI event cannot activate this feature
  // for an unrelated Desktop turn.
  const conversationVariant = inferVariant(
    events.filter(event => event.conversation_id === conversationId),
  );
  if (conversationVariant !== 'cursor-cli') return;
  const resourceAttributes = findConversationResourceAttributes(events, conversationId);
  if (Object.keys(resourceAttributes).length === 0) return;

  const baseFieldPatch = agentBaseFieldPatch(resourceAttributes);
  for (const record of records) {
    Object.assign(record, baseFieldPatch, { resourceAttributes });
  }
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toolCallIdsFromMessages(messages) {
  const ids = new Set();
  if (!Array.isArray(messages)) return ids;
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (part?.type === 'tool_call' && part.id) ids.add(part.id);
    }
  }
  return ids;
}

/**
 * Merge synthetic Skill reads into the previous round's single assistant
 * output, then add one independent tool-role response message per Skill read.
 */
function mergeSkillExchange(
  messages,
  sourceToolCallIds,
  sourceHadToolCalls,
  callParts,
  responseParts,
) {
  const merged = Array.isArray(messages) ? cloneJson(messages) : [];
  const existingPartIds = new Set(merged.flatMap(message =>
    Array.isArray(message?.parts) ? message.parts.map(part => part?.id).filter(Boolean) : []
  ));
  const pendingCalls = callParts.filter(part => !existingPartIds.has(part.id));
  if (pendingCalls.length === 0) return merged;

  const responseById = new Map(responseParts.map(part => [part.id, part]));
  const responseMessages = pendingCalls.flatMap(call => {
    const response = responseById.get(call.id);
    return response ? [{ role: 'tool', parts: [cloneJson(response)] }] : [];
  });

  let assistantIndex = merged.findIndex(message =>
    message?.role === 'assistant' &&
    message.parts?.some(part => part?.id && sourceToolCallIds.has(part.id))
  );
  // Cursor can omit tool_use_id while still preserving the prior assistant in
  // request history. In that case reuse the first assistant (the target is the
  // first LLM response) instead of creating a second, Skill-only assistant.
  // Keep the no-source-tool path unchanged: there is no prior tool assistant to
  // reuse, so the synthetic exchange must remain its own assistant message.
  if (assistantIndex < 0 && sourceHadToolCalls) {
    assistantIndex = merged.findIndex(message => message?.role === 'assistant');
  }

  if (assistantIndex < 0) {
    const firstHistoryIndex = merged.findIndex(message =>
      message?.role === 'assistant' || message?.role === 'tool'
    );
    const insertAt = firstHistoryIndex >= 0 ? firstHistoryIndex : merged.length;
    merged.splice(
      insertAt,
      0,
      { role: 'assistant', parts: cloneJson(pendingCalls) },
      ...responseMessages,
    );
  } else {
    merged[assistantIndex].parts.push(...cloneJson(pendingCalls));
    let insertAt = assistantIndex + 1;
    while (insertAt < merged.length && merged[insertAt]?.role === 'tool') insertAt++;
    merged.splice(insertAt, 0, ...responseMessages);
  }
  return merged;
}

function injectSkillRecords(records, skills, runtimeConfig = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return;
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
  const sourceToolCallIds = toolCallIdsFromMessages(outputMsgs);
  const sourceHadToolCalls = outputMsgs.some(message =>
    message?.role === 'assistant' &&
    message.parts?.some(part => part?.type === 'tool_call')
  );

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

  const skillCallParts = skillEntries.map(({ skill, toolCallId }) => ({
    type: 'tool_call',
    id: toolCallId,
    name: 'Read',
    arguments: { path: skill.skillPath },
  }));
  // Preserve the call/response relationship without copying SKILL.md content.
  const skillResponseParts = skillEntries.map(({ toolCallId }) => ({
    type: 'tool_call_response',
    id: toolCallId,
    response: '',
  }));

  // The assemblers computed request history before this post-assembly injection.
  // Backfill the immediate next request's delta/full messages, then keep the
  // synthetic exchange in every later full context for this same turn.
  const targetTraceId = llmRecord.trace_id;
  const targetTurnId = llmRecord['gen_ai.turn.id'];
  const laterRequestIndexes = [];
  for (let index = targetLlmIdx + 1; index < records.length; index++) {
    const record = records[index];
    if (record['event.name'] !== 'llm.request') continue;
    if (record['gen_ai.agent.scope'] === 'subagent') continue;
    if (targetTraceId && record.trace_id !== targetTraceId) continue;
    if (targetTurnId && record['gen_ai.turn.id'] !== targetTurnId) continue;
    laterRequestIndexes.push(index);
  }
  for (let index = 0; index < laterRequestIndexes.length; index++) {
    const requestIndex = laterRequestIndexes[index];
    const request = records[requestIndex];
    if (index === 0) {
      request['gen_ai.input.messages_delta'] = mergeSkillExchange(
        request['gen_ai.input.messages_delta'],
        sourceToolCallIds,
        sourceHadToolCalls,
        skillCallParts,
        skillResponseParts,
      );
    }
    request['gen_ai.input.messages'] = mergeSkillExchange(
      request['gen_ai.input.messages'],
      sourceToolCallIds,
      sourceHadToolCalls,
      skillCallParts,
      skillResponseParts,
    );
    records[requestIndex] = applyPolicy(request, runtimeConfig);
  }

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
      'gen_ai.skill.id': skill.skillId || skill.skillName,
      'agent.cursor.skill_detection_source':
        skill.detectionSource || 'transcript_post_assembly',
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
      'gen_ai.skill.id': skill.skillId || skill.skillName,
      'agent.cursor.skill_detection_source':
        skill.detectionSource || 'transcript_post_assembly',
    }, runtimeConfig));
  }

  // Insert after the first LLM response.
  records.splice(targetLlmIdx + 1, 0, ...insertRecords);
}

function filterSkillsForReadInjection(skills, assembledFromTranscript) {
  return skills.filter(skill => {
    const sources = skill.detectionSources || [];
    const hasExplicitUsageSignal = sources.includes('manual_attachment') ||
      sources.includes('agent_skill');

    if (!assembledFromTranscript) {
      return hasExplicitUsageSignal ||
        sources.includes('transcript_read');
    }

    // The transcript assembler already materializes real Read tool_use entries.
    // Only synthesize a Read when an explicit user-row signal has no matching
    // transcript Read. A skill with both sources already has its real Read in the
    // assembled step.
    return hasExplicitUsageSignal &&
      !sources.includes('transcript_read');
  });
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
  const invocationResourceAttributes = collectResourceAttributesFromEnv(process.env, {
    agentId: 'cursor-cli',
  });
  if (Object.keys(invocationResourceAttributes).length > 0) {
    internalEvent.resource_attributes = invocationResourceAttributes;
  }
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
          if (detectedSkills && detectedSkills.length > 0) {
            // The Windows transcript assembler already materializes transcript
            // Read tool_use entries. Synthesize only pure manual attachments on
            // that path; hook-event assembly still needs both evidence sources.
            const readSkills = filterSkillsForReadInjection(
              detectedSkills,
              assembledFromTranscript,
            );
            if (readSkills.length > 0) {
              injectSkillRecords(records, readSkills, runtimeConfig);
            }
          }
        }
      } catch { /* best-effort skill detection — never block output */ }

      applyCursorCliResourceContext(records, allEvents, convId, variant);

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

        applyCursorCliResourceContext(result.records, allEvents, convId, variant);

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

export {
  applyCursorCliResourceContext,
  filterSkillsForReadInjection,
  findConversationResourceAttributes,
  injectSkillRecords,
};
