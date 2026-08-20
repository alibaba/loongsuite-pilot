import { describe, expect, it } from 'vitest';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import {
  applyInvocationIdentity,
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
} from '../../../src/normalization/invocation-identity.js';

describe('applyInvocationIdentity', () => {
  it('gives invocation identity precedence and removes transport fields', () => {
    const entry = buildTestEntry({
      userId: 'native-user',
      sessionId: 'native-session',
    });
    entry[INVOCATION_SESSION_ID_FIELD] = ' invocation-session ';
    entry[INVOCATION_USER_ID_FIELD] = ' invocation-user ';

    applyInvocationIdentity(entry, 'configured-user', 'fallback-user');

    expect(entry['gen_ai.session.id']).toBe('invocation-session');
    expect(entry['user.id']).toBe('invocation-user');
    expect(entry).not.toHaveProperty(INVOCATION_SESSION_ID_FIELD);
    expect(entry).not.toHaveProperty(INVOCATION_USER_ID_FIELD);
  });

  it('preserves the existing configured/native/fallback user precedence without an override', () => {
    const configured = buildTestEntry({ userId: 'native-user' });
    applyInvocationIdentity(configured, 'configured-user', 'fallback-user');
    expect(configured['user.id']).toBe('configured-user');

    const native = buildTestEntry({ userId: 'native-user' });
    applyInvocationIdentity(native, '', 'fallback-user');
    expect(native['user.id']).toBe('native-user');

    const fallback = buildTestEntry({ userId: '' });
    applyInvocationIdentity(fallback, '', 'fallback-user');
    expect(fallback['user.id']).toBe('fallback-user');
  });

  it('ignores invalid transport values but always removes them', () => {
    const entry = buildTestEntry({ userId: 'native-user', sessionId: 'native-session' });
    entry[INVOCATION_SESSION_ID_FIELD] = ' ';
    entry[INVOCATION_USER_ID_FIELD] = 'x'.repeat(513);

    applyInvocationIdentity(entry, 'configured-user', 'fallback-user');

    expect(entry['gen_ai.session.id']).toBe('native-session');
    expect(entry['user.id']).toBe('configured-user');
    expect(entry).not.toHaveProperty(INVOCATION_SESSION_ID_FIELD);
    expect(entry).not.toHaveProperty(INVOCATION_USER_ID_FIELD);
  });
});
