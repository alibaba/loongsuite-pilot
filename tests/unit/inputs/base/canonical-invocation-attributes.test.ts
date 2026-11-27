import { describe, expect, it } from 'vitest';
import { buildCanonicalHookEntry } from '../../../../src/inputs/base/canonical-hook-record.js';
import { INVOCATION_ATTRIBUTES_FIELD } from '../../../../assets/hooks/shared/invocation-attributes.mjs';

describe('canonical producer invocation snapshot', () => {
  it('does not expose the carrier and projects it only when the adapter opts in', () => {
    const record = {
      'event.name': 'other', 'gen_ai.agent.type': 'fixture', 'user.id': 'native',
      [INVOCATION_ATTRIBUTES_FIELD]: { 'memory.user_id': ' tenant:user,甲 ', 'memory.attempt': 1, 'memory.enabled': false },
      'memory.user_id': 'legacy',
    };
    expect(buildCanonicalHookEntry(record, 'fixture')).not.toHaveProperty('memory.attempt');
    const entry = buildCanonicalHookEntry(record, 'fixture', undefined, {
      preserveInvocationAttributes: true, preserveSafeCustomTopLevelFields: true,
    });
    expect(entry).toMatchObject({ 'user.id': 'native', 'memory.user_id': ' tenant:user,甲 ',
      'memory.attempt': 1, 'memory.enabled': false });
    expect(entry).not.toHaveProperty(INVOCATION_ATTRIBUTES_FIELD);
  });
});
