import type { NativeContent } from './doubao-work-content.js';
import { doubaoDigest } from './doubao-work-log.js';

const MAX_ROUNDS = 64;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

export interface ObservedMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: Record<string, unknown>[];
}
export interface NativeAssistantRound {
  id: string;
  sourceIndex: number;
  ordinal: number;
  inputMessages: ObservedMessage[];
  outputMessages: ObservedMessage[];
  callIds: string[];
  tools: { callId: string; name: string; completed: boolean; arguments?: Record<string, unknown>; result?: string }[];
  inputTruncated: boolean;
  scope: 'client_request' | 'local_execution_fragment';
}
export interface NativeRoundReconstruction {
  rounds: NativeAssistantRound[];
  omittedRounds: number;
  duplicateAssistantRows: number;
}

/** Reconstruct visible message history, never an unobserved provider prompt,
 * request ID, model, finish reason, token count or model timestamp. */
export function reconstructNativeRounds(
  content: NativeContent | undefined, actor: string, queryMs: number, endNano: string, callIds: string[],
  scope: NativeAssistantRound['scope'] = 'client_request',
): NativeRoundReconstruction | undefined {
  const rows = content?.transcripts?.[actor], assignments = content?.assignments[actor] ?? [];
  if (!rows || !/^\d{19}$/.test(endNano)) return undefined;
  const endMs = Number(BigInt(endNano) / 1_000_000n);
  const current = assignments.filter(item => item.timeMs >= queryMs && item.timeMs <= endMs);
  const bodies = [...new Set(current.map(item => item.text))];
  if (bodies.length !== 1 || current.length !== 1) return undefined;
  const body = bodies[0];
  const demandKey = nativeDemandKey(body);
  const matchesDemand = (value: unknown) => typeof value === 'string'
    && value.length <= MAX_INPUT_BYTES && nativeDemandKey(value) === demandKey;
  const delimiters = rows.flatMap((row, index) => row.role === 'user' && matchesDemand(row.content) ? [index] : []);
  if (delimiters.length > 1 || (delimiters.length === 0
    && (assignments[0]?.text !== body || rows[0]?.role === 'user'))) return undefined;
  let first = delimiters.length === 1 ? delimiters[0] + 1 : 0;
  let last = rows.findIndex((row, index) => index >= first && row.role === 'user');
  if (last < 0) last = rows.length;
  const known = callIds.map(id => content!.calls[id]);
  if (known.some(call => !call || call.actor !== actor || call.resultIndex === undefined
    || call.recordIndex < first || call.recordIndex >= last)) return undefined;
  if (scope === 'local_execution_fragment') {
    if (!known.length) return undefined;
    first = Math.min(...known.map(call => call.recordIndex));
    const finalResult = Math.max(...known.map(call => call.resultIndex!));
    // A native execution only proves its local fragment. Do not import later
    // cloud coordination from a reused organizer's entire transcript.
    last = finalResult + 1;
    const next = rows[last];
    if (next?.role === 'assistant' && !(Array.isArray(next.tool_calls) && next.tool_calls.length)) last++;
  }

  const history: ObservedMessage[] = [];
  const initial = assignments[0]?.text;
  if (initial && !(rows[0]?.role === 'user' && typeof rows[0].content === 'string'
    && nativeDemandKey(rows[0].content) === nativeDemandKey(initial))) {
    history.push({ role: 'user', parts: [{ type: 'text', content: initial }] });
  }
  const rounds: NativeAssistantRound[] = [];
  let total = 0, omittedRounds = 0, duplicateAssistantRows = 0;
  let capacityReached = false;
  let previousAssistant: string | undefined;
  for (let index = 0; index < last; index++) {
    const row = rows[index], message = visibleMessage(row);
    if (!message) continue;
    const encoded = JSON.stringify(message);
    if (row.role === 'assistant' && previousAssistant === encoded && !(Array.isArray(row.tool_calls) && row.tool_calls.length)) {
      if (index >= first) duplicateAssistantRows++;
      continue;
    }
    if (row.role === 'assistant' && index >= first) {
      if (capacityReached || rounds.length >= MAX_ROUNDS) { omittedRounds++; previousAssistant = encoded; continue; }
      const input = history.slice();
      let inputBytes = Buffer.byteLength(JSON.stringify(input)), inputTruncated = false;
      while (inputBytes > MAX_INPUT_BYTES && input.length > 1) {
        input.shift(); inputTruncated = true; inputBytes = Buffer.byteLength(JSON.stringify(input));
      }
      const rawCalls = Array.isArray(row.tool_calls) ? row.tool_calls as { id: string }[] : [];
      const tools = rawCalls.map(raw => {
        const call = content!.calls[raw.id];
        return { callId: raw.id, name: call.name, completed: call.resultIndex !== undefined,
          ...(call.arguments === undefined ? {} : { arguments: JSON.parse(call.arguments) as Record<string, unknown> }),
          ...(call.result === undefined ? {} : { result: call.result }) };
      });
      const round: NativeAssistantRound = {
        id: doubaoDigest(JSON.stringify([actor, queryMs, index, encoded])), sourceIndex: index,
        ordinal: rounds.length + 1, inputMessages: input, outputMessages: [message],
        callIds: rawCalls.map(call => call.id), tools, inputTruncated, scope,
      };
      const bytes = Buffer.byteLength(JSON.stringify(round));
      if (inputBytes > MAX_INPUT_BYTES || total + bytes > MAX_TOTAL_BYTES) { omittedRounds++; capacityReached = true; }
      else { rounds.push(round); total += bytes; }
    }
    history.push(message);
    previousAssistant = row.role === 'assistant' ? encoded : undefined;
  }
  return { rounds, omittedRounds, duplicateAssistantRows };
}

/** The client expands its own Skill URI before persisting a user message.
 * Compare only those two observed reference forms; preserve all instructions,
 * labels and original message content. Typed tokens avoid collisions with
 * arbitrary Markdown or a user-written normalization placeholder. */
function nativeDemandKey(value: string): string {
  const parts: (string | { skill: string; label: string })[] = [];
  const links = /\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))\)/g;
  let cursor = 0;
  for (const match of value.matchAll(links)) {
    const target = match[2] ?? match[3];
    const uri = /^skill:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\?[^\s<>]*)?$/.exec(target);
    const local = /^(?:[a-zA-Z]:\/|\/)[^\r\n<>]*\/\.doubaowork\/agent_mode\/workspace\/\.skills\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/SKILL\.md$/.exec(target.replace(/\\/g, '/'));
    const skill = uri?.[1] ?? local?.[1];
    if (!skill) continue;
    parts.push(value.slice(cursor, match.index), { skill, label: match[1] });
    cursor = match.index! + match[0].length;
  }
  parts.push(value.slice(cursor));
  return JSON.stringify(parts);
}

function visibleMessage(row: Record<string, unknown>): ObservedMessage | undefined {
  if (!['user', 'assistant', 'tool'].includes(String(row.role))) return undefined;
  const parts: Record<string, unknown>[] = [];
  if (row.role === 'tool') {
    if (typeof row.tool_call_id !== 'string' || !ID.test(row.tool_call_id) || typeof row.content !== 'string') return undefined;
    parts.push({ type: 'tool_call_response', id: row.tool_call_id, response: row.content });
  } else {
    if (typeof row.content === 'string' && row.content) parts.push({ type: 'text', content: row.content });
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) for (const raw of row.tool_calls) {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof call.id !== 'string' || !ID.test(call.id) || typeof call.function?.name !== 'string') return undefined;
      let args = call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return undefined; }
      }
      parts.push({ type: 'tool_call', id: call.id, name: call.function.name,
        ...(args && typeof args === 'object' && !Array.isArray(args) ? { arguments: args } : {}) });
    }
  }
  return parts.length ? { role: row.role as ObservedMessage['role'], parts } : undefined;
}
