import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';

const EVENTS = new Set([
  'on_message_session_start', 'on_message_sending_start',
  'on_message_sending_end', 'general_agent_message_id_mapping', 'on_message_session_end',
]);
const MIN_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);

export interface DoubaoLogEvent {
  name: string;
  timeNano: string;
  queryMs?: number;
  turnId?: string;
  conversationId?: string;
  localMessageId?: string;
  clientOutcome?: 'received' | 'ended' | 'error' | 'cancelled';
}

/** Only bounded identifiers are retained; no log payload, prompt or error text. */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value) ? value : undefined;
}

function epoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_EPOCH_MS && value < MAX_EPOCH_MS ? value : undefined;
}

/** Chromium's header is local wall time; the filename supplies the missing year. */
function sourceTime(line: string, fileName: string): string | undefined {
  const fileDate = /^saman_frontend_(\d{4})\.(\d{2})(\d{2})\.\d+\.log$/.exec(fileName);
  const header = /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{6}):INFO:FRONTEND\(0\)\]/.exec(line);
  if (!fileDate || !header) return undefined;
  const [, month, day, hour, minute, second, micros] = header.map(Number);
  const fileYear = Number(fileDate[1]);
  const fileAnchor = new Date(fileYear, Number(fileDate[2]) - 1, Number(fileDate[3])).getTime();
  const candidates = [fileYear - 1, fileYear, fileYear + 1].map(year =>
    new Date(year, month - 1, day, hour, minute, second, Math.floor(micros / 1000)));
  const date = candidates.sort((a, b) => Math.abs(a.getTime() - fileAnchor) - Math.abs(b.getTime() - fileAnchor))[0];
  if (date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  return (BigInt(date.getTime()) * 1_000_000n + BigInt(micros % 1000) * 1000n).toString();
}

/** Parse the embedded logger object, not the outer Chromium log wrapper. */
export function parseDoubaoLogLine(line: string, fileName: string): DoubaoLogEvent | undefined {
  if (!line.includes('[office-api-logger]')) return undefined;
  const begin = line.indexOf('{"version":');
  const end = line.lastIndexOf('}');
  if (begin < 0 || end < begin) return undefined;
  let object: Record<string, unknown>;
  try { object = JSON.parse(line.slice(begin, end + 1)); } catch { return undefined; }
  if (object.version !== 1 || typeof object.eventName !== 'string' || !EVENTS.has(object.eventName)) return undefined;
  if (!object.meta || typeof object.meta !== 'object' || Array.isArray(object.meta)) return undefined;
  const timeNano = sourceTime(line, fileName);
  if (!timeNano) return undefined;
  const meta = object.meta as Record<string, unknown>;
  // These are per-request SDK sessions, not persistent conversations.
  const turnId = identifier(meta.chat_session_id);
  const queryMs = epoch(meta.query_send_timestamp);
  if (object.eventName !== 'general_agent_message_id_mapping' && (!turnId || queryMs === undefined)) return undefined;
  let clientOutcome: DoubaoLogEvent['clientOutcome'];
  if (object.eventName === 'on_message_session_end') {
    const cancelled = identifier(meta.cancel_source);
    clientOutcome = cancelled && cancelled !== 'none' && cancelled !== '0' ? 'cancelled'
      : (meta.session_success === '0' || meta.session_success === 0 || meta.session_success === false) ? 'error'
      : (meta.receive_success === '1' || meta.receive_success === 1 || meta.receive_success === true) ? 'received' : 'ended';
  }
  return {
    name: object.eventName, timeNano, queryMs, turnId, clientOutcome,
    conversationId: identifier(meta.conversation_id ?? meta.conversationId),
    localMessageId: identifier(meta.send_local_message_id ?? meta.localMessageId),
  };
}

export interface DoubaoPendingTurn {
  turnId: string;
  queryMs: number;
  conversationId?: string;
  localMessageId?: string;
  updatedMs: number;
}

export function doubaoDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A client-message observation deliberately contains no synthetic model step. */
export function buildDoubaoTaskEvents(
  scope: string, pending: DoubaoPendingTurn, terminal: DoubaoLogEvent, observedMs: number,
): AgentActivityEntry[] {
  const conversationId = terminal.conversationId ?? pending.conversationId;
  if (!conversationId || terminal.queryMs !== pending.queryMs) return [];
  const start = BigInt(pending.queryMs) * 1_000_000n;
  const end = BigInt(terminal.timeNano);
  if (end <= start) return [];
  const identity = JSON.stringify([scope, conversationId, pending.turnId, pending.queryMs]);
  const outcome = terminal.clientOutcome ?? 'ended';
  const common: AgentActivityEntry = {
    time_unix_nano: start.toString(),
    observed_time_unix_nano: (BigInt(observedMs) * 1_000_000n).toString(),
    'event.id': '', 'event.name': 'other', 'user.id': '',
    trace_id: doubaoDigest(identity).slice(0, 32),
    'gen_ai.session.id': conversationId,
    'gen_ai.turn.id': pending.turnId,
    'gen_ai.agent.type': 'doubao-work',
    'gen_ai.agent.id': 'doubao-work',
    'gen_ai.agent.name': 'Doubao Work',
    'gen_ai.agent.system': 'doubao',
    'gen_ai.framework': 'doubao-work',
    'gen_ai.provider.name': 'bytedance.doubao',
    'loongsuite.doubao_work.observation_scope': 'client_message',
    'loongsuite.doubao_work.business_outcome': 'unknown',
    'loongsuite.doubao_work.client_outcome': outcome,
    resourceAttributes: {
      'loongsuite.doubao_work.observation_scope': 'client_message',
      'loongsuite.doubao_work.business_outcome': 'unknown',
      'loongsuite.doubao_work.client_outcome': outcome,
    },
  };
  return [
    {
      ...common, 'event.id': doubaoDigest(`${identity}:start`),
      'gen_ai.turn.start': true,
      // Existing converter contract: a content-free input boundary, not a prompt.
      'gen_ai.input.messages_delta': [],
    },
    {
      ...common, time_unix_nano: end.toString(),
      'event.id': doubaoDigest(`${identity}:end`), 'gen_ai.turn.end': true,
      ...(outcome === 'error' ? {
        'error.type': 'doubao.client_request_failed',
      } : outcome === 'cancelled' ? {
        'error.type': 'doubao.client_request_cancelled',
      } : {}),
    },
  ];
}
