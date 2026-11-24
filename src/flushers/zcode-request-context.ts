import { parseZCodeMessageWindow, ZCODE_MESSAGE_WINDOW } from '../normalization/zcode-message-window.js';
import type { AgentActivityEntry, JsonValue } from '../types/index.js';

interface RequestContext {
  count: number;
  observedAt: bigint;
  messages: JsonValue[];
}

/**
 * Replay only contiguous native message windows within the buffered turn.
 * Keep the original event log and its redaction policy intact.
 */
export function prepareZCodeRequestContext(records: AgentActivityEntry[]): AgentActivityEntry[] {
  const contexts = new Map<string, RequestContext>();
  return records.map(record => {
    if (record['event.name'] !== 'llm.request') return record;
    const session = record['gen_ai.session.id'];
    const turn = record['gen_ai.turn.id'];
    if (!session || !turn || !record.trace_id) return record;
    const key = JSON.stringify([record.trace_id, session, turn]);
    const window = parseZCodeMessageWindow(record[ZCODE_MESSAGE_WINDOW]);
    if (!window || !/^\d{1,24}$/.test(record.time_unix_nano)) {
      contexts.delete(key);
      return record;
    }

    const time = BigInt(record.time_unix_nano);
    const prior = contexts.get(key);
    const raw = record['gen_ai.input.messages'];
    // A captured empty delta is []. An absent field may have been redacted,
    // so it invalidates any previous message context even at an empty window.
    const captured = Array.isArray(raw) && raw.length <= window.length ? raw : undefined;
    if (!captured || (prior && time < prior.observedAt)) {
      contexts.delete(key);
      return record;
    }
    if (window.kind === 'full') {
      if (captured.length) contexts.set(key, { count: window.count, observedAt: time, messages: captured });
      else contexts.delete(key);
      return record;
    }
    if (!prior || prior.count !== window.offset || (window.length > 0 && !captured.length)) {
      contexts.delete(key);
      return record;
    }
    const messages = captured.length ? [...prior.messages, ...captured] : prior.messages;
    contexts.set(key, { count: window.count, observedAt: time, messages });
    return { ...record, 'gen_ai.input.messages': messages };
  });
}
