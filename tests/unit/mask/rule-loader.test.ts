import { describe, expect, it } from 'vitest';

import type { MaskConfig } from '../../../src/types/index.js';
import {
  compileSensitiveRules,
  loadEnabledRules,
  loadSensitiveRules,
} from '../../../src/mask/rule-loader.js';

describe('mask rule loader', () => {
  const allConfig: MaskConfig = { mode: 'all', types: [] };

  it('loads collector mask rules from the manifest', () => {
    const ruleIds = loadSensitiveRules().map((rule) => rule.id);

    expect(ruleIds).toContain('cloudAccessKey.alicloud.accessKeyId');
    expect(ruleIds).toContain('cloudAccessKey.aws.accessKeyId');
    expect(ruleIds).toContain('cloudAccessKey.tencent.secretId');
    expect(ruleIds).toContain('apiKey.openaiCompatible');
    expect(ruleIds).toContain('apiKey.github');
    expect(ruleIds).toContain('privateKey.pem');
    expect(ruleIds).toContain('databaseUrl.withPassword');
    expect(ruleIds).toContain('databaseUrl.jdbcWithPassword');
  });

  it('returns all rules when mask mode is all', () => {
    const allRules = loadSensitiveRules();
    const enabledRules = loadEnabledRules(allConfig);

    expect(enabledRules).toHaveLength(allRules.length);
  });

  it('returns only selected rule types when mask mode is custom', () => {
    const config: MaskConfig = { mode: 'custom', types: ['apiKey'] };
    const enabledRules = loadEnabledRules(config);

    expect(enabledRules.length).toBeGreaterThan(0);
    expect(enabledRules.every((rule) => rule.type === 'apiKey')).toBe(true);
  });

  it('returns no rules when mask mode is none', () => {
    const enabledRules = loadEnabledRules({ mode: 'none', types: [] });

    expect(enabledRules).toHaveLength(0);
  });

  it('keeps database URL prefilters aligned with supported database schemes', () => {
    const rule = loadSensitiveRules().find(item => item.id === 'databaseUrl.withPassword');

    expect(rule?.normalizedPrefilter).toEqual([
      'mysql://',
      'postgres://',
      'postgresql://',
      'mongodb://',
      'redis://',
    ]);
    expect(rule?.normalizedPrefilter).not.toContain('://');
    expect(rule?.normalizedPrefilter).not.toContain('@');
  });

  it('uses password-specific JDBC prefilters instead of broad jdbc prefix', () => {
    const rule = loadSensitiveRules().find(item => item.id === 'databaseUrl.jdbcWithPassword');

    expect(rule?.normalizedPrefilter).toEqual(['password=', 'pwd=']);
    expect(rule?.normalizedPrefilter).not.toContain('jdbc:');
  });

  it('rejects invalid regex definitions', () => {
    expect(() =>
      compileSensitiveRules({
        version: 1,
        rules: [
          {
            id: 'broken.regex',
            type: 'apiKey',
            kind: 'regex',
            replacement: '[APIKEY_MASKED]',
            prefilter: ['sk-'],
            pattern: '[',
            flags: 'g',
          },
        ],
      }),
    ).toThrow(/broken\.regex/);
  });
});
