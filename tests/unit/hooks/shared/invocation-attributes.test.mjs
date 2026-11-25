import { describe, expect, it } from 'vitest';
import {
  INVOCATION_ATTRIBUTES_FIELD,
  parseInvocationAttributes,
  projectInvocationAttributes,
} from '../../../../assets/hooks/shared/invocation-attributes.mjs';

describe('native invocation attributes', () => {
  it('snapshots JSON scalars with exact values and accepts explicit absence', () => {
    const source = { 'memory.user_id': ' 用户,甲=1 ', 'business.attempt': 2, 'business.enabled': false };
    const snapshot = parseInvocationAttributes(source);
    source['memory.user_id'] = 'changed';
    expect(snapshot).toEqual({ 'memory.user_id': ' 用户,甲=1 ', 'business.attempt': 2, 'business.enabled': false });
    expect(parseInvocationAttributes({})).toEqual({});
  });

  it.each([
    [], null, { 'tool.name': 'override' }, { 'User.Id': 'override' }, { 'service.name': 'override' },
    { 'gen_ai.session.id': 'override' }, { parent_span_id: 'override' }, { 'billing.apiKey': 'blocked' },
    { 'tags.password': 'blocked' }, { [INVOCATION_ATTRIBUTES_FIELD]: 'not a field' },
    JSON.parse('{"__proto__":"blocked"}'), { constructor: 'blocked' }, { 'memory.a': ['not scalar'] },
    { 'memory.a': NaN }, { 'memory.a': 2 ** 53 }, { 'memory.a': 'a'.repeat(513) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['a'+i, 1])),
    Object.fromEntries(Array.from({ length: 24 }, (_, i) => ['a'+i, '中'.repeat(511)])),
  ].map(input => ({ input })))('rejects inadmissible map $input', ({ input }) => {
    expect(() => parseInvocationAttributes(input)).toThrow();
  });

  it('drops the entire malformed group and cannot overwrite a native field', () => {
    const event = { 'agentcore.task_id': 'native' };
    projectInvocationAttributes(event, { 'agentcore.task_id': 'changed', 'memory.enabled': false });
    projectInvocationAttributes(event, { 'memory.a': 'valid', 'trace_id': 'invalid' });
    expect(event).toEqual({ 'agentcore.task_id': 'native', 'memory.enabled': false });
  });
});
