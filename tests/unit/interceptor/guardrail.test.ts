import { describe, expect, it } from 'vitest';
import { stampGuardrail, guardrailSnapshotFromVerdict } from '../../../src/interceptor/guardrail.js';
import { normalizeGuardrailEntry } from '../../../src/normalization/guardrail-fields.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const retired = ['reason', 'message', 'matched', 'enforcement', 'title', 'severity', 'match'];

describe('guardrail output schema', () => {
  it('preserves an explicitly empty rule version through verdict projection and stamping', () => {
    const snapshot = guardrailSnapshotFromVerdict({ action: 'block', ruleId: 'fixed-rule', ruleVersion: '', evaluatedRules: [] });
    expect(snapshot).toEqual({ action: 'block', ruleId: 'fixed-rule', ruleVersion: '' });
    const entry = buildTestEntry();
    stampGuardrail(entry, snapshot);
    expect(entry).toMatchObject({ 'gen_ai.guardrail.rule_id': 'fixed-rule', 'gen_ai.guardrail.rule_version': '' });
  });
  it.each([
    [{ action: 'block' }, 'block'],
    [{ action: 'block', matched: true }, 'block'],
    [{ action: 'allow', matched: true }, 'log'],
    [{ action: 'allow', matched: true, failOpen: true }, 'log'],
    [{ action: 'allow', matched: false }, 'allow'],
    [{ action: 'allow', failOpen: true }, 'allow'],
    [{ action: 'allow' }, 'allow'],
  ] as const)('maps %j to %s without exporting rule details', (verdict, action) => {
    const entry = buildTestEntry();
    const snapshot = guardrailSnapshotFromVerdict({ ...verdict, evaluatedRules: [], ruleId: 'policy', ruleVersion: '2',
      reason: 'private reason', title: 'private title', message: 'private message' });
    stampGuardrail(entry, snapshot);
    expect(entry['gen_ai.guardrail.triggered']).toBe(true);
    expect(entry['gen_ai.guardrail.action']).toBe(action);
    for (const field of retired) expect(entry).not.toHaveProperty(`gen_ai.guardrail.${field}`);
    if (action !== 'allow') {
      expect(entry['gen_ai.guardrail.rule_id']).toBe('policy');
      expect(entry['gen_ai.guardrail.rule_version']).toBe('2');
    } else {
      expect(entry).not.toHaveProperty('gen_ai.guardrail.rule_id');
      expect(entry).not.toHaveProperty('gen_ai.guardrail.rule_version');
    }
  });

  it('strips diagnostic fields from records and nested attributes without changing the source', () => {
    const fields = { ...Object.fromEntries(retired.map(field => [`gen_ai.guardrail.${field}`, 'private'])),
      'gen_ai.guardrail.triggered': true, 'gen_ai.guardrail.action': 'log',
      'gen_ai.guardrail.rule_id': 'policy', 'gen_ai.guardrail.rule_version': '2' };
    const result = normalizeGuardrailEntry({ ...fields, attributes: fields });
    for (const record of [result, result.attributes]) {
      expect(record).toMatchObject({ 'gen_ai.guardrail.triggered': true, 'gen_ai.guardrail.action': 'log',
        'gen_ai.guardrail.rule_id': 'policy', 'gen_ai.guardrail.rule_version': '2' });
      for (const field of retired) expect(record).not.toHaveProperty(`gen_ai.guardrail.${field}`);
    }
    expect(fields['gen_ai.guardrail.action']).toBe('log');
    expect(fields['gen_ai.guardrail.enforcement']).toBe('private');
  });
});
