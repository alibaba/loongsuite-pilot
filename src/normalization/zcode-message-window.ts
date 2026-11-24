import type { JsonValue } from '../types/index.js';

export const ZCODE_MESSAGE_WINDOW = 'agent.zcode.rollout.message_window';

type MessageWindow = { kind: 'full' | 'delta'; offset: number; count: number; length: number };

export function parseZCodeMessageWindow(value: JsonValue | undefined): MessageWindow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, offset, count, length } = value;
  if ((kind !== 'full' && kind !== 'delta') ||
      typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 ||
      typeof count !== 'number' || !Number.isSafeInteger(count) || count !== offset + length ||
      (kind === 'full' && offset !== 0)) return undefined;
  return { kind, offset, count, length };
}

export function readZCodeMessageWindow(request: Record<string, unknown>): MessageWindow | undefined {
  if (!Array.isArray(request.messages)) return undefined;
  const { messagesKind, messageOffset, messageCount } = request;
  if (typeof messagesKind !== 'string' || typeof messageOffset !== 'number' || typeof messageCount !== 'number') {
    return undefined;
  }
  return parseZCodeMessageWindow({
    kind: messagesKind, offset: messageOffset, count: messageCount, length: request.messages.length,
  });
}
