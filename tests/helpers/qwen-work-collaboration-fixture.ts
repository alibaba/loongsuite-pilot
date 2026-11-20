export function collaborationFixture(now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const stamp = (offset: number) => ({ seconds: String(seconds + offset), nanos: 123_456_789 });
  const chunk = (text: string) => ({ method: 'session/update', params: {
    sessionId: 'synthetic-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  } });
  const content = [
    { method: '_qwenwork/space_turn', params: { spaceId: 'synthetic-space', turnId: 'synthetic-turn' } },
    { method: 'session/prompt', params: { sessionId: 'synthetic-session' } },
    chunk('Hello '),
    { method: 'session/update', params: { sessionId: 'synthetic-session', update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'not visible output' },
    } } },
    chunk('world'),
    { id: 'request-1', result: { stopReason: 'end_turn' } },
  ].map(row => JSON.stringify({ jsonrpc: '2.0', ...row })).join('\n') + '\n';
  return {
    version: 1,
    accounts: {
      'synthetic-account': {
        accountId: 'synthetic-account', userId: 'synthetic-user', orgId: 'synthetic-org',
        messages: {
          prompt: { messageId: 'prompt', conversationId: 'space', text: 'Synthetic question',
            sender: { id: 'synthetic-user', type: 'HUMAN' }, createdAt: stamp(0) },
          reply: { messageId: 'reply', conversationId: 'space', replyToMessageId: 'prompt',
            cardRef: { cardId: 'card' }, sender: { id: 'synthetic-employee', type: 'DE' }, createdAt: stamp(1) },
        },
        cards: {
          card: { cardId: 'card', resourceState: 'AVAILABLE', contentStatus: 'CARD_CONTENT_STATUS_FINAL',
            contentFormat: 'CARD_CONTENT_FORMAT_ACP_NDJSON_V1', content, partial: false,
            messageLink: { cid: 'space', messageId: 'reply' }, terminalAt: stamp(3) },
        },
      },
    },
  };
}
