import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promptHash, promptLookupFromEntry } from '../../interceptor/prompt-verdict.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { queryReadonly } from '../../utils/node-sqlite.js';

const PROMPT_SKEW_MS = 5000;
const MAX_PROMPT_ROWS = 32;
const MAX_CALL_PARTS = 1024;

export interface QwenWorkCNFlashSource {
  desktopDb: string;
  flashDb: string;
}

interface SessionBinding {
  id: string;
  sessionId: string;
  hostSessionId: string;
  subChatId: string;
  nativeSessionId: string;
  engineId: string;
  storageNamespace: string;
}

export async function readFlashSessionBindings(
  { desktopDb, flashDb }: QwenWorkCNFlashSource,
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const bindings = new Map<string, string>();
  if (!sessionIds.length || !(await isFile(flashDb)) || !(await isFile(desktopDb))) return bindings;
  const limit = sessionIds.length * 2;
  const rows = await queryReadonly<SessionBinding>(desktopDb, `
    SELECT id, session_id AS sessionId,
      json_extract(ext, '$.engineSessionBindingV1.hostSessionId') AS hostSessionId,
      json_extract(ext, '$.engineSessionBindingV1.subChatId') AS subChatId,
      json_extract(ext, '$.engineSessionBindingV1.nativeSessionId') AS nativeSessionId,
      json_extract(ext, '$.engineSessionBindingV1.engineId') AS engineId,
      json_extract(ext, '$.engineSessionBindingV1.storageNamespace') AS storageNamespace
    FROM sub_chats
    WHERE session_id IN (SELECT value FROM json_each(?)) AND json_valid(ext)
    LIMIT ?
  `, [JSON.stringify(sessionIds), limit + 1]);
  if (rows.length > limit) return bindings;
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (row.engineId !== 'opencode' || row.sessionId !== row.hostSessionId || row.id !== row.subChatId
      || typeof row.nativeSessionId !== 'string' || !row.nativeSessionId
      || typeof row.storageNamespace !== 'string' || !path.isAbsolute(row.storageNamespace)
      || path.normalize(row.storageNamespace) !== flashDb) continue;
    if (bindings.has(row.sessionId)) ambiguous.add(row.sessionId);
    bindings.set(row.sessionId, row.nativeSessionId);
  }
  for (const sessionId of ambiguous) bindings.delete(sessionId);
  return bindings;
}

async function isFile(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined))?.isFile() === true;
}

export interface QwenWorkCNModelStep {
  request: AgentActivityEntry;
  response: AgentActivityEntry;
  toolIds: readonly string[];
}

interface FlashPart {
  messageId: string;
  model: string | null;
  type: 'tool' | 'step-finish';
  callId: string | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export async function enrichFlashModelSteps(
  db: string,
  sessionId: string,
  steps: readonly QwenWorkCNModelStep[],
): Promise<void> {
  const first = steps[0];
  if (!first) return;
  const prompt = promptLookupFromEntry(first.request);
  const observedAt = Math.floor(Number(first.request.observed_time_unix_nano) / 1e6);
  if (!prompt || !Number.isSafeInteger(observedAt) || observedAt < prompt.at) return;

  // Hook UUIDs are desktop IDs, not Flash message IDs. Match the prompt within
  // the bound native session and require a single native user-message owner.
  const promptRows = await queryReadonly<{ id: string; text: string }>(db, `
    SELECT m.id, json_extract(p.data, '$.text') AS text
    FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
    WHERE m.session_id = ? AND m.time_created BETWEEN ? AND ?
      AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
      AND json_extract(p.data, '$.synthetic') IS NOT 1
      AND length(json_extract(p.data, '$.text')) <= 131072
    ORDER BY m.time_created, m.id, p.id LIMIT ${MAX_PROMPT_ROWS + 1}
  `, [sessionId, prompt.at - PROMPT_SKEW_MS, Math.min(observedAt, prompt.at + PROMPT_SKEW_MS)]);
  if (promptRows.length > MAX_PROMPT_ROWS) return;
  const promptParts = new Map<string, string[]>();
  for (const row of promptRows) {
    if (typeof row.text !== 'string') continue;
    const parts = promptParts.get(row.id) ?? [];
    parts.push(row.text);
    promptParts.set(row.id, parts);
  }
  const owners = [...promptParts].filter(([, parts]) => promptHash(parts.join('\n')) === prompt.promptHash);
  if (owners.length !== 1) return;

  // A step-finish part is a single model call. The assistant message's
  // tokens field can describe only its last step in a tool workflow.
  const rows = await queryReadonly<FlashPart>(db, `
    SELECT m.id AS messageId, json_extract(m.data, '$.modelID') AS model,
      json_extract(p.data, '$.type') AS type, json_extract(p.data, '$.callID') AS callId,
      json_extract(p.data, '$.tokens.input') AS input, json_extract(p.data, '$.tokens.output') AS output,
      json_extract(p.data, '$.tokens.reasoning') AS reasoning,
      json_extract(p.data, '$.tokens.cache.read') AS cacheRead, json_extract(p.data, '$.tokens.cache.write') AS cacheWrite
    FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
    WHERE m.session_id = ? AND m.time_created BETWEEN ? AND ?
      AND json_extract(m.data, '$.role') = 'assistant' AND json_extract(m.data, '$.parentID') = ?
      AND json_extract(p.data, '$.type') IN ('tool', 'step-finish')
    ORDER BY m.time_created, m.id, p.id LIMIT ${MAX_CALL_PARTS + 1}
  `, [sessionId, prompt.at - PROMPT_SKEW_MS, observedAt, owners[0]![0]]);
  if (rows.length > MAX_CALL_PARTS) return;

  const calls: Array<{ finish: FlashPart; toolIds: string[] }> = [];
  let toolIds: string[] = [];
  let messageId: string | undefined;
  for (const row of rows) {
    if (messageId !== row.messageId && toolIds.length) return;
    messageId = row.messageId;
    if (row.type === 'tool') {
      if (!row.callId) return;
      toolIds.push(row.callId);
    } else {
      calls.push({ finish: row, toolIds: toolIds.sort() });
      toolIds = [];
    }
  }
  if (toolIds.length || calls.length !== steps.length || steps.some((step, index) => {
    const actual = calls[index]!.toolIds;
    const expected = [...step.toolIds].sort();
    return actual.length !== expected.length || actual.some((id, i) => id !== expected[i]);
  })) return;
  steps.forEach((step, index) => applyFlashUsage(step, calls[index]!.finish));
}

function applyFlashUsage({ request, response }: QwenWorkCNModelStep, call: FlashPart): void {
  const model = typeof call.model === 'string' ? call.model.trim() : '';
  if (model && model !== 'auto' && model !== 'unknown' && model.length <= 512) {
    for (const event of [request, response]) {
      const current = event['gen_ai.request.model'];
      if (!current || current === 'unknown' || current === 'auto') event['gen_ai.request.model'] = model;
    }
    const responseModel = response['gen_ai.response.model'];
    if (responseModel === 'unknown' || responseModel === 'auto' || (responseModel === model && model.startsWith('mode-'))) {
      // Flash records the requested model/route in message.modelID.
      delete response['gen_ai.response.model'];
    }
  }

  if (response['gen_ai.usage.input_tokens'] !== undefined || response['gen_ai.usage.output_tokens'] !== undefined) return;
  const { input: uncached, output: text, reasoning, cacheRead, cacheWrite } = call;
  if (!isTokenCount(uncached) || !isTokenCount(text) || !isTokenCount(reasoning)
    || !isTokenCount(cacheRead) || !isTokenCount(cacheWrite)) return;
  // Flash stores uncached input and text output separately from cache and reasoning.
  const input = uncached + cacheRead + cacheWrite;
  const output = text + reasoning;
  const total = input + output;
  if (total === 0 || !Number.isSafeInteger(total)) return;
  response['gen_ai.usage.input_tokens'] = input;
  response['gen_ai.usage.output_tokens'] = output;
  response['gen_ai.usage.total_tokens'] = total;
  if (cacheRead) response['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
  if (cacheWrite) response['gen_ai.usage.cache_creation.input_tokens'] = cacheWrite;
}

function isTokenCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
