import * as crypto from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import { toJsonValue } from '../../normalization/entry-builder.js';

export interface CursorCliContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export type CursorCliRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; texts: string[]; toolCalls: Array<{ name: string; args: unknown }> }
  | { kind: 'end'; status: string };

const MAX_ARG_BYTES = 64 * 1024;

function sha32(parts: Array<string | number>): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

function capValue(value: unknown): JsonValue {
  const json = toJsonValue(value) ?? '';
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  if (Buffer.byteLength(text) <= MAX_ARG_BYTES) return json;
  return `${text.slice(0, MAX_ARG_BYTES)}...[truncated]`;
}

function blockText(block: CursorCliContentBlock): string | null {
  if (block?.type !== 'text' || typeof block.text !== 'string') return null;
  return block.text;
}

export function parseTranscriptRow(record: Record<string, unknown>): CursorCliRow | null {
  if (record.type === 'turn_ended') {
    return { kind: 'end', status: typeof record.status === 'string' ? record.status : 'unknown' };
  }
  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const blocks = (message as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return null;
  if (record.role === 'user') {
    const text = blocks.map(blockText).filter((t): t is string => t !== null).join('\n');
    return { kind: 'user', text };
  }
  if (record.role === 'assistant') {
    const texts: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const text = blockText(block as CursorCliContentBlock);
      if (text !== null) {
        texts.push(text);
        continue;
      }
      const typed = block as CursorCliContentBlock;
      if (typed.type === 'tool_use' && typeof typed.name === 'string') {
        toolCalls.push({ name: typed.name, args: typed.input });
      }
    }
    return { kind: 'assistant', texts, toolCalls };
  }
  return null;
}

export interface CursorCliTurn {
  userTexts: string[];
  assistantTexts: string[];
  toolCalls: Array<{ name: string; args: unknown }>;
  status: string;
}

function textParts(texts: string[]): Array<{ type: string; content: string }> {
  return texts.filter((t) => t.length > 0).map((content) => ({ type: 'text', content }));
}

export function buildTurnEntries(
  sessionId: string,
  turnSeq: number,
  turn: CursorCliTurn,
  timeNanos: string,
): AgentActivityEntry[] {
  if (turn.userTexts.length === 0 && turn.assistantTexts.length === 0 && turn.toolCalls.length === 0) {
    return [];
  }
  const traceId = sha32(['cursor-cli-transcript', sessionId, turnSeq]);
  const turnId = `${sessionId}:t${turnSeq}`;
  const stepId = `${turnId}:s1`;
  const eventId = (suffix: string): string => sha32([sessionId, turnSeq, suffix]);
  const base = {
    time_unix_nano: timeNanos,
    trace_id: traceId,
    'user.id': '',
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': ClientType.CursorCli,
    'gen_ai.agent.id': sessionId,
    'gen_ai.provider.name': 'unknown',
  };
  const entries: AgentActivityEntry[] = [];
  entries.push({
    ...base,
    'event.id': eventId('turn-start'),
    'event.name': 'other',
    'gen_ai.turn.start': true,
    ...(turn.userTexts.length > 0
      ? {
        'gen_ai.input.messages_delta': [
          { role: 'user', parts: textParts(turn.userTexts) },
        ],
      }
      : {}),
  });
  entries.push({
    ...base,
    'event.id': eventId('llm-request'),
    'event.name': 'llm.request',
    'gen_ai.step.id': stepId,
  });
  turn.toolCalls.forEach((call, index) => {
    entries.push({
      ...base,
      'event.id': eventId(`tool-call-${index}`),
      'event.name': 'tool.call',
      'gen_ai.step.id': stepId,
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': `${turnId}:tool:${index}`,
      'gen_ai.tool.call.arguments': capValue(call.args),
    });
  });
  const outputParts: JsonValue[] = [
    ...textParts(turn.assistantTexts).map((part) => ({ ...part })),
    ...turn.toolCalls.map((call, index) => ({
      type: 'tool_call',
      id: `${turnId}:tool:${index}`,
      name: call.name,
      arguments: capValue(call.args),
    })),
  ];
  entries.push({
    ...base,
    'event.id': eventId('llm-response'),
    'event.name': 'llm.response',
    'gen_ai.step.id': stepId,
    'gen_ai.response.finish_reasons': [turn.status === 'error' ? 'error' : 'stop'],
    ...(outputParts.length > 0
      ? { 'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts }] }
      : {}),
  });
  entries.push({
    ...base,
    'event.id': eventId('turn-end'),
    'event.name': 'other',
    'gen_ai.turn.end': true,
    ...(turn.status === 'error' ? { 'error.type': 'turn_error' } : {}),
  });
  return entries;
}
