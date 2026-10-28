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
  const steps = nativeRoundSteps(content, actor, queryMs, endNano, callIds, scope);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** The collector resumes this iterator across cycles; synchronous fixture and
 * benchmark callers retain the exact same result through the wrapper above. */
export function* nativeRoundSteps(
  content: NativeContent | undefined, actor: string, queryMs: number, endNano: string, callIds: string[],
  scope: NativeAssistantRound['scope'] = 'client_request',
): Generator<number, NativeRoundReconstruction | undefined> {
  const rows = content?.transcripts?.[actor], assignments = content?.assignments[actor] ?? [];
  const offset = content?.transcriptOffsets?.[actor] ?? 0;
  if (!rows || !/^\d{19}$/.test(endNano)) return undefined;
  const endMs = Number(BigInt(endNano) / 1_000_000n);
  const current = assignments.filter(item => item.timeMs >= queryMs && item.timeMs <= endMs);
  const bodies = [...new Set(current.map(item => item.text))];
  if (bodies.length !== 1 || current.length !== 1) return undefined;
  const body = bodies[0];
  const demandKey = nativeDemandKey(body);
  const matchesDemand = (value: unknown) => typeof value === 'string'
    && value.length <= MAX_INPUT_BYTES && nativeDemandKey(value) === demandKey;
  const indexed = content?.findUserRows?.(actor, nativeDemandFingerprint(body));
  const delimiters = indexed === undefined
    ? rows.flatMap((row, index) => row.role === 'user' && matchesDemand(row.content) ? [index] : [])
    : indexed.filter(index => index >= offset && index < offset + rows.length).map(index => index - offset);
  if (delimiters.length > 1 || (delimiters.length === 0
    && (offset > 0 || assignments[0]?.text !== body || rows[0]?.role === 'user'))) return undefined;
  let first = delimiters.length === 1 ? delimiters[0] + 1 : 0;
  let last = rows.findIndex((row, index) => index >= first && row.role === 'user');
  if (last < 0) last = rows.length;
  const known = callIds.map(id => content!.calls[id]);
  if (known.some(call => !call || call.actor !== actor || call.resultIndex === undefined
    || call.recordIndex < first + offset || call.recordIndex >= last + offset)) return undefined;
  if (scope === 'local_execution_fragment') {
    if (!known.length) return undefined;
    first = Math.min(...known.map(call => call.recordIndex)) - offset;
    const finalResult = Math.max(...known.map(call => call.resultIndex!)) - offset;
    // A native execution only proves its local fragment. Do not import later
    // cloud coordination from a reused organizer's entire transcript.
    last = finalResult + 1;
    const next = rows[last];
    if (next?.role === 'assistant' && !(Array.isArray(next.tool_calls) && next.tool_calls.length)) last++;
  }

  const history = new MessageWindow(MAX_INPUT_BYTES);
  history.truncated = offset > 0;
  // Earlier turns only contribute their byte-bounded suffix. Work backwards
  // to that boundary instead of decoding every unchanged historical message.
  const prefix: { message: ObservedMessage; encoded: string }[] = [];
  let prefixBytes = 2, previousEncoded: string | undefined, previousAssistant: string | undefined;
  let prefixComplete = true, havePrevious = false;
  for (let index = first - 1; index >= 0; index--) {
    const row = rows[index], message = visibleMessage(row);
    if (!message) continue;
    const encoded = JSON.stringify(message);
    if (!havePrevious) { previousAssistant = row.role === 'assistant' ? encoded : undefined; havePrevious = true; }
    const duplicate = row.role === 'assistant' && previousEncoded === encoded && !(Array.isArray(row.tool_calls) && row.tool_calls.length);
    previousEncoded = row.role === 'assistant' ? encoded : undefined;
    if (duplicate) continue;
    const bytes = Buffer.byteLength(encoded) + (prefix.length ? 1 : 0);
    if (prefix.length && prefixBytes + bytes > MAX_INPUT_BYTES) { prefixComplete = false; history.truncated = true; break; }
    prefix.push({ message, encoded }); prefixBytes += bytes;
  }
  const initial = assignments[0]?.text;
  if (!offset && prefixComplete && initial && !(rows[0]?.role === 'user' && typeof rows[0].content === 'string'
    && nativeDemandKey(rows[0].content) === nativeDemandKey(initial))) {
    const message: ObservedMessage = { role: 'user', parts: [{ type: 'text', content: initial }] };
    history.push(message, JSON.stringify(message));
  }
  for (let index = prefix.length - 1; index >= 0; index--) history.push(prefix[index].message, prefix[index].encoded);
  const rounds: NativeAssistantRound[] = [];
  let total = 0, omittedRounds = 0, duplicateAssistantRows = 0;
  let capacityReached = false;
  for (let index = first; index < last; index++) {
    if (index > first && (index - first) % 256 === 0) yield 256;
    const row = rows[index], message = visibleMessage(row);
    if (!message) continue;
    const encoded = JSON.stringify(message);
    if (row.role === 'assistant' && previousAssistant === encoded && !(Array.isArray(row.tool_calls) && row.tool_calls.length)) {
      if (index >= first) duplicateAssistantRows++;
      continue;
    }
    if (row.role === 'assistant' && index >= first) {
      if (capacityReached || rounds.length >= MAX_ROUNDS) { omittedRounds++; previousAssistant = encoded; continue; }
      const input = history.messages();
      const inputBytes = history.bytes, inputTruncated = history.truncated;
      const rawCalls = Array.isArray(row.tool_calls) ? row.tool_calls as { id: string }[] : [];
      const tools = rawCalls.map(raw => {
        const call = content!.calls[raw.id];
        return { callId: raw.id, name: call.name, completed: call.resultIndex !== undefined,
          ...(call.arguments === undefined ? {} : { arguments: JSON.parse(call.arguments) as Record<string, unknown> }),
          ...(call.result === undefined ? {} : { result: call.result }) };
      });
      const round: NativeAssistantRound = {
        id: doubaoDigest(JSON.stringify([actor, queryMs, index + offset, encoded])), sourceIndex: index + offset,
        ordinal: rounds.length + 1, inputMessages: input, outputMessages: [message],
        callIds: rawCalls.map(call => call.id), tools, inputTruncated, scope,
      };
      const bytes = Buffer.byteLength(JSON.stringify(round));
      if (inputBytes > MAX_INPUT_BYTES || total + bytes > MAX_TOTAL_BYTES) { omittedRounds++; capacityReached = true; }
      else { rounds.push(round); total += bytes; }
    }
    history.push(message, encoded);
    previousAssistant = row.role === 'assistant' ? encoded : undefined;
  }
  return { rounds, omittedRounds, duplicateAssistantRows };
}

/** Keep the same suffix as serializing and repeatedly trimming the complete
 * history. Each message is encoded once; array punctuation is counted exactly,
 * including UTF-8 and JSON escapes. One oversized last message is retained so
 * the existing round omission rule, rather than an invented empty input, wins.
 */
class MessageWindow {
  private rows: { message: ObservedMessage; bytes: number }[] = [];
  private head = 0;
  bytes = 2;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(message: ObservedMessage, encoded: string): void {
    const bytes = Buffer.byteLength(encoded);
    this.bytes += bytes + (this.rows.length > this.head ? 1 : 0);
    this.rows.push({ message, bytes });
    while (this.bytes > this.limit && this.rows.length - this.head > 1) {
      this.bytes -= this.rows[this.head++].bytes + 1;
      this.truncated = true;
    }
    if (this.head > 1024 && this.head * 2 > this.rows.length) {
      this.rows = this.rows.slice(this.head);
      this.head = 0;
    }
  }

  messages(): ObservedMessage[] { return this.rows.slice(this.head).map(row => row.message); }
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

/** A bounded lookup key, not source content and never an exported identity. */
export function nativeDemandFingerprint(value: string): string { return doubaoDigest(nativeDemandKey(value)); }

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
