import { describe, expect, it } from 'vitest';
import { ClientType } from '../../../../src/types/index.js';
import { buildCanonicalHookEntry } from '../../../../src/inputs/base/canonical-hook-record.js';
import { transformHookRecord } from '../../../../src/inputs/base/hook-record-transform.js';

describe('hook record resource attribute passthrough', () => {
  it('preserves resourceAttributes in generic hook transform', async () => {
    const entry = await transformHookRecord({
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.response.finish_reasons': ['stop'],
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    }, ClientType.ClaudeCliHook, 'claude-code');

    expect(entry).toMatchObject({
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    });
  });

  it('preserves resourceAttributes in canonical hook transform', () => {
    const entry = buildCanonicalHookEntry({
      'event.id': 'event-2',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-2',
      'gen_ai.agent.type': 'claude-code',
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    }, ClientType.ClaudeCliHook);

    expect(entry).toMatchObject({
      resourceAttributes: {
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      },
    });
  });
});

describe('canonical hook custom top-level field passthrough', () => {
  const canonicalRecord = {
    'event.id': 'event-custom-1',
    'event.name': 'llm.response',
    'gen_ai.session.id': 'session-custom-1',
    'gen_ai.agent.type': 'qoder-cli',
  };

  it('keeps strict canonical behavior by default', () => {
    const entry = buildCanonicalHookEntry({
      ...canonicalRecord,
      'multica.issue.id': 'AGE-992',
    }, ClientType.QoderCli);

    expect(entry).not.toHaveProperty('multica.issue.id');
  });

  it('preserves safe string fields when explicitly enabled', () => {
    const entry = buildCanonicalHookEntry(
      {
        ...canonicalRecord,
        'multica.issue.id': 'AGE-992',
        'multica.user.id': ' staff-1 ',
      },
      ClientType.QoderCli,
      undefined,
      { preserveSafeCustomTopLevelFields: true },
    );

    expect(entry).toMatchObject({
      'event.name': 'llm.response',
      'multica.issue.id': 'AGE-992',
      'multica.user.id': 'staff-1',
    });
  });

  it('drops unsafe custom fields when passthrough is enabled', () => {
    const entry = buildCanonicalHookEntry(
      {
        ...canonicalRecord,
        'multica.api_token': 'secret',
        'multica.count': 42,
        'multica.empty': ' ',
        'multica.comma': 'one,two',
        'multica.too_long': 'x'.repeat(513),
        cost_custom: 'reserved',
        'event.custom': 'reserved',
      },
      ClientType.QoderCli,
      undefined,
      { preserveSafeCustomTopLevelFields: true },
    );

    expect(entry).not.toHaveProperty('multica.api_token');
    expect(entry).not.toHaveProperty('multica.count');
    expect(entry).not.toHaveProperty('multica.empty');
    expect(entry).not.toHaveProperty('multica.comma');
    expect(entry).not.toHaveProperty('multica.too_long');
    expect(entry).not.toHaveProperty('cost_custom');
    expect(entry).not.toHaveProperty('event.custom');
  });
});
