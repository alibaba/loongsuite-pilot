import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType } from '../../types/index.js';

type ObjectValue = Record<string, unknown>;

export interface CollaborationTurn {
  key: string;
  completedAtMs: number;
  entries: AgentActivityEntry[];
}

/** Parse only the read-only IM projection. Never infer a model call from a card. */
export function* collaborationTurns(
  value: unknown, includedConversations?: ReadonlySet<string>,
): Generator<CollaborationTurn> {
  const state = object(value);
  if (state?.version !== 1 || !object(state.accounts)) throw new Error('unsupported collaboration state');
  for (const [accountKey, rawAccount] of Object.entries(state.accounts as ObjectValue)) {
    const account = object(rawAccount);
    const messages = object(account?.messages);
    const cards = object(account?.cards);
    if (!account || !messages || !cards) continue;
    const userId = text(account.userId);
    if (!userId) continue;
    const identity = [accountKey, userId, text(account.orgId) ?? ''];
    for (const replyKey in messages) {
      if (!Object.hasOwn(messages, replyKey)) continue;
      const rawReply = messages[replyKey];
      const reply = object(rawReply);
      const replyId = text(reply?.messageId);
      const conversation = text(reply?.conversationId);
      const promptId = text(reply?.replyToMessageId);
      const cardId = text(object(reply?.cardRef)?.cardId);
      if (!reply || !replyId || replyId !== replyKey || !conversation || !promptId || !cardId
        || (includedConversations && !includedConversations.has(conversation))
        || !isAgent(reply.sender) || revoked(account, conversation)
        || object(account.removedMessages)?.[replyId] !== undefined) continue;
      const prompt = object(messages[promptId]);
      if (!prompt || prompt.messageId !== promptId || prompt.conversationId !== conversation
        || !isHuman(prompt.sender) || object(account.removedMessages)?.[promptId] !== undefined) continue;
      // A member's local IM snapshot also contains other people's messages.
      // Collect only the signed-in account's own turns, so another member's
      // collector does not attribute this exchange to the observing user.
      if (text(object(prompt.sender)?.id) !== userId) continue;
      const input = text(prompt.text);
      const card = object(cards[cardId]);
      if (!input || !card || card.cardId !== cardId || card.resourceState !== 'AVAILABLE'
        || !['FINAL', 'CARD_CONTENT_STATUS_FINAL'].includes(String(card.contentStatus))
        || card.partial === true || card.contentUnsupported === true) continue;
      const link = object(card.messageLink);
      if (link && ((text(link.cid) && link.cid !== conversation)
        || (text(link.messageId) && link.messageId !== replyId))) continue;
      const output = cardText(card);
      const start = timeNanos(prompt.createdAt);
      const terminalAt = timeNanos(card.terminalAt);
      const end = terminalAt ?? timeNanos(card.updatedAt);
      if (!output || !start || !end || end <= start) continue;
      const completedAtMs = Number(end / 1_000_000n);
      if (!Number.isSafeInteger(completedAtMs)) continue;

      const session = digest(['session', ...identity, conversation]);
      const turn = digest(['turn', ...identity, conversation, replyId]);
      const common: AgentActivityEntry = {
        time_unix_nano: start.toString(),
        observed_time_unix_nano: (BigInt(Date.now()) * 1_000_000n).toString(),
        'event.id': '',
        'event.name': 'other',
        'user.id': text(object(prompt.sender)?.id) ?? '',
        'gen_ai.session.id': session,
        'gen_ai.turn.id': turn,
        'gen_ai.agent.type': ClientType.QwenWorkCN,
        'gen_ai.agent.id': text(object(reply.sender)?.id) ?? 'qwen-work-cn',
        // The IM snapshot does not identify the model provider. Keep the
        // required field empty instead of inferring it from the product name.
        'gen_ai.provider.name': '',
        'agent.source': 'qwen-work-cn-collaboration',
      };
      yield {
        key: turn,
        completedAtMs,
        entries: [
          { ...common, 'event.id': digest(['start', turn]), 'gen_ai.turn.start': true,
            'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: input }] }] },
          { ...common, 'event.id': digest(['end', turn]), time_unix_nano: end.toString(),
            'gen_ai.turn.end': true,
            'loongsuite.qwenworkcn.completion_time_source': terminalAt ? 'card.terminalAt' : 'card.updatedAt',
            'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: output }] }] },
        ],
      };
    }
  }
}

function cardText(card: ObjectValue): string | undefined {
  const format = text(card.contentFormat);
  const content = typeof card.content === 'string' ? card.content
    : typeof card.markdown === 'string' ? card.markdown : undefined;
  if (!content || Buffer.byteLength(content) > 512 * 1024) return undefined;
  if (!format || format === 'CARD_CONTENT_FORMAT_UNSPECIFIED') return content;
  if (format !== 'CARD_CONTENT_FORMAT_ACP_NDJSON_V1' || !content.endsWith('\n')) return undefined;
  let output = '';
  let session: string | undefined;
  let prompts = 0;
  let terminal = false;
  for (const line of content.slice(0, -1).split('\n')) {
    let record: ObjectValue | undefined;
    try { record = object(JSON.parse(line)); } catch { return undefined; }
    if (!record || record.jsonrpc !== '2.0') return undefined;
    const params = object(record.params);
    const update = object(params?.update);
    if (object(update?._meta)?.content_blocked === true || object(update?._meta)?.compressed === true
      || record.method === '_qwenwork/compression'
      || (record.method === '_qwenwork/notice' && params?.code === 'CONTENT_TOO_LARGE')) return undefined;
    const sessionId = text(params?.sessionId);
    if (sessionId && session && sessionId !== session) return undefined;
    if (sessionId) session = sessionId;
    if (record.method === 'session/prompt') {
      if (++prompts > 1) return undefined;
      terminal = false;
    }
    if (record.method === 'session/cancel' || record.error) return undefined;
    if (record.method === undefined && typeof object(record.result)?.stopReason === 'string') {
      if (object(record.result)?.stopReason === 'cancelled') return undefined;
      terminal = true;
    }
    if (record.method !== 'session/update' || update?.sessionUpdate !== 'agent_message_chunk' || terminal) continue;
    const parts = Array.isArray(update.content) ? update.content : [update.content];
    for (const part of parts) {
      output += acpText(part, 0);
    }
  }
  return output || undefined;
}

function acpText(value: unknown, depth: number): string {
  if (depth > 4) return '';
  const part = object(value);
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  if (part?.type === 'content') {
    const parts = Array.isArray(part.content) ? part.content : [part.content];
    return parts.map(item => acpText(item, depth + 1)).join('\n');
  }
  return '';
}

function revoked(account: ObjectValue, conversation: string): boolean {
  const attention = object(account.attention);
  const key = JSON.stringify([conversation, '']);
  if (object(attention?.denied)?.[key]) return true;
  return Boolean(object(account.removedConversations)?.[conversation]
    && !object(attention?.grants)?.[key]);
}

function timeNanos(value: unknown): bigint | undefined {
  const timestamp = object(value);
  const seconds = timestamp?.seconds;
  const nanos = timestamp?.nanos ?? 0;
  if ((typeof seconds !== 'string' && typeof seconds !== 'number')
    || !/^\d{1,11}$/.test(String(seconds)) || !Number.isInteger(nanos)
    || Number(nanos) < 0 || Number(nanos) >= 1_000_000_000) return undefined;
  return BigInt(seconds) * 1_000_000_000n + BigInt(Number(nanos));
}

function isHuman(value: unknown): boolean {
  const sender = object(value);
  return Boolean(text(sender?.id) && ['HUMAN', 'PRINCIPAL_TYPE_HUMAN'].includes(String(sender?.type)));
}

function isAgent(value: unknown): boolean {
  const sender = object(value);
  return Boolean(text(sender?.id) && ['DE', 'AGENT', 'PRINCIPAL_TYPE_DE', 'PRINCIPAL_TYPE_AGENT'].includes(String(sender?.type)));
}

function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function digest(value: string[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
