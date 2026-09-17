import { describe, expect, it } from 'vitest';

import { collectSensitiveRanges, findFirstSensitiveMatch } from '../../../src/mask/detect.js';
import { loadEnabledRules } from '../../../src/mask/rule-loader.js';
import type { MaskConfig } from '../../../src/types/index.js';

describe('sensitive detect', () => {
  const allRules = loadEnabledRules({ mode: 'all', types: [] } satisfies MaskConfig);

  it('finds cloud access keys, API keys, private keys, and database URLs', () => {
    expect(findFirstSensitiveMatch('aliyun=LTAI1234567890ABCD', allRules)?.replacement)
      .toBe('[ACCESSKEY_MASKED]');
    expect(findFirstSensitiveMatch('aws=AKIAIOSFODNN7EXAMPLE', allRules)?.replacement)
      .toBe('[ACCESSKEY_MASKED]');
    expect(findFirstSensitiveMatch('openai=sk-1234567890abcdefghijklmnop', allRules)?.replacement)
      .toBe('[APIKEY_MASKED]');
    expect(findFirstSensitiveMatch(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----',
      allRules,
    )?.replacement).toBe('[PRIVATEKEY_MASKED]');
    expect(findFirstSensitiveMatch(
      'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot',
      allRules,
    )?.replacement).toBe('[DATABASEURL_MASKED]');
    expect(findFirstSensitiveMatch(
      'jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12',
      allRules,
    )?.replacement).toBe('[DATABASEURL_MASKED]');
  });

  it('does not match short keys or passwordless database URLs', () => {
    expect(findFirstSensitiveMatch('short_aliyun=LTAI123', allRules)).toBeUndefined();
    expect(findFirstSensitiveMatch('mysql://localhost:3306/pilot', allRules)).toBeUndefined();
    expect(collectSensitiveRanges('hello world', allRules)).toEqual([]);
  });

  it('returns the leftmost secret when several types appear', () => {
    const hit = findFirstSensitiveMatch(
      'sk-1234567890abcdefghijklmnop then LTAI1234567890ABCD',
      allRules,
    );
    expect(hit?.replacement).toBe('[APIKEY_MASKED]');
    expect(hit?.ruleId).toBe('apiKey.openaiCompatible');
  });
});
