import { describe, expect, it } from 'vitest';
import { collaborationTurns } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-collaboration-parser.js';
import { resolveQwenWorkCNCollaborationRoot } from '../../../src/inputs/qwen-work-cn/qwen-work-cn-collaboration-input.js';
import { collaborationFixture } from '../../helpers/qwen-work-collaboration-fixture.js';

describe('Qwen Work collaboration state', () => {
  it('only emits allowed conversations when a scope is supplied', () => {
    const state = collaborationFixture();
    expect([...collaborationTurns(state, new Set(['space']))]).toHaveLength(1);
    expect([...collaborationTurns(state, new Set(['different-space']))]).toHaveLength(0);
    expect([...collaborationTurns(state, new Set())]).toHaveLength(0);
    expect([...collaborationTurns(state)]).toHaveLength(1);
  });

  it('reconstructs the user and final visible answer without inventing model events', () => {
    const state = collaborationFixture();
    const [turn] = [...collaborationTurns(state)];
    expect(turn.entries.map(entry => entry['event.name'])).toEqual(['other', 'other']);
    expect(turn.entries[0]['gen_ai.turn.start']).toBe(true);
    expect(turn.entries[1]['gen_ai.turn.end']).toBe(true);
    expect(turn.entries[0]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Synthetic question' }] },
    ]);
    expect(turn.entries[1]['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello world' }] },
    ]);
    expect(turn.entries[0]).not.toHaveProperty('gen_ai.provider.name');
    expect(turn.entries[0]['loongsuite.observation.scope']).toBe('agent_turn');
    expect(JSON.stringify(turn.entries)).not.toMatch(/not visible output|gen_ai.request.model|gen_ai.usage/);
    expect([...collaborationTurns(state)][0].entries.map(entry => entry['event.id']))
      .toEqual(turn.entries.map(entry => entry['event.id']));
  });

  it('collects only the signed-in account author, not another member observing the same turn', () => {
    const authorView = collaborationFixture();
    expect([...collaborationTurns(authorView)]).toHaveLength(1);
    const observerView = structuredClone(authorView);
    observerView.accounts['synthetic-account'].userId = 'other-member';
    expect([...collaborationTurns(observerView)]).toEqual([]);
    observerView.accounts['synthetic-account'].userId = '';
    expect([...collaborationTurns(observerView)]).toEqual([]);
  });

  it('uses the Electron user-data root for each platform', () => {
    expect(resolveQwenWorkCNCollaborationRoot('darwin', '/home/test', {}))
      .toBe('/home/test/Library/Application Support/QwenWorkCN/data/collaboration');
    expect(resolveQwenWorkCNCollaborationRoot('win32', 'C:\\Users\\test', { APPDATA: 'D:\\Roaming' }))
      .toBe('D:\\Roaming\\QwenWorkCN\\data\\collaboration');
    expect(resolveQwenWorkCNCollaborationRoot('linux', '/home/test', { XDG_CONFIG_HOME: '/config' }))
      .toBe('/config/QwenWorkCN/data/collaboration');
  });

  it('does not collect unlinked, streaming, revoked, partial or ambiguous conversations', () => {
    const cases = [
      (s: any) => { s.accounts['synthetic-account'].messages.reply.replyToMessageId = ''; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.contentStatus = 'CARD_CONTENT_STATUS_STREAMING'; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.partial = true; },
      (s: any) => { s.accounts['synthetic-account'].messages.prompt.sender.type = 'DE'; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.messageLink.cid = 'other-space'; },
      (s: any) => { s.accounts['synthetic-account'].removedMessages = { prompt: { revision: '2' } }; },
      (s: any) => { s.accounts['synthetic-account'].attention = { denied: { '["space",""]': true } }; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.content += '{bad json}\n'; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.content += JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { _meta: { content_blocked: true } } } }) + '\n'; },
      (s: any) => { s.accounts['synthetic-account'].cards.card.content += JSON.stringify({ jsonrpc: '2.0', method: 'session/prompt', params: {} }) + '\n'; },
    ];
    for (const mutate of cases) {
      const state = collaborationFixture(); mutate(state);
      expect([...collaborationTurns(state)]).toEqual([]);
    }
  });

  it('supports legacy markdown and keeps replies in different accounts or spaces distinct', () => {
    const state = collaborationFixture();
    const account = state.accounts['synthetic-account'];
    account.cards.card.contentFormat = 'CARD_CONTENT_FORMAT_UNSPECIFIED';
    account.cards.card.content = 'A legacy answer';
    const first = [...collaborationTurns(state)][0];
    expect(JSON.stringify(first.entries)).toContain('A legacy answer');
    const second = structuredClone(state) as any;
    second.accounts.other = second.accounts['synthetic-account'];
    delete second.accounts['synthetic-account'];
    expect([...collaborationTurns(second)][0].key).not.toBe(first.key);
  });
});
