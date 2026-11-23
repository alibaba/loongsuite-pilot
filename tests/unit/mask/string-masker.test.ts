import { describe, expect, it } from 'vitest';

import { loadEnabledRules, loadMaskPlan } from '../../../src/mask/rule-loader.js';
import {
  applyMaskRanges,
  isLargeString,
  maskString,
} from '../../../src/mask/string-masker.js';
import type { MaskConfig } from '../../../src/types/index.js';

describe('mask string masker', () => {
  const allConfig: MaskConfig = { mode: 'all', types: [] };
  const allRules = loadEnabledRules(allConfig);

  it('masks supported cloud access keys and API keys', () => {
    const input = [
      'aliyun=LTAI1234567890ABCD',
      'aws=AKIAIOSFODNN7EXAMPLE',
      'sts=ASIAABCDEFGHIJKLMNOP',
      'aws_abia=ABIAABCDEFGHIJKLMNOP',
      'aws_acca=ACCAABCDEFGHIJKLMNOP',
      'tencent=AKIDabcdefghijklmnopqrstuvwxyz',
      'openai=sk-1234567890abcdefghijklmnop',
      'github=ghp_1234567890abcdefghijklmnop',
    ].join('\n');

    const masked = maskString(input, allRules);

    expect(masked).toContain('[ACCESSKEY_MASKED]');
    expect(masked).toContain('[APIKEY_MASKED]');
    expect(masked).not.toContain('LTAI1234567890ABCD');
    expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(masked).not.toContain('ASIAABCDEFGHIJKLMNOP');
    expect(masked).not.toContain('ABIAABCDEFGHIJKLMNOP');
    expect(masked).not.toContain('ACCAABCDEFGHIJKLMNOP');
    expect(masked).not.toContain('AKIDabcdefghijklmnopqrstuvwxyz');
    expect(masked).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(masked).not.toContain('ghp_1234567890abcdefghijklmnop');
  });

  it('masks a Secret-like candidate only after a valid cloud access key ID', () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==';
    const withoutAccessKeyId = `ordinary output ${secret}`;
    const withMalformedAccessKeyId = `AKIA1234:${secret}`;
    const withAccessKeyId = `AKIA1234567890ABCDEF:${secret}`;

    expect(maskString(withoutAccessKeyId, allRules)).toBe(withoutAccessKeyId);
    expect(maskString(withMalformedAccessKeyId, allRules)).toBe(withMalformedAccessKeyId);
    expect(maskString(withAccessKeyId, allRules)).toBe(
      '[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]',
    );
  });

  it('accepts 20 through 60 character Secret candidates and rejects adjacent lengths', () => {
    const candidate = (length: number): string =>
      'Aa1'.repeat(Math.ceil(length / 3)).slice(0, length);
    const values = [19, 20, 60, 61].map(length => candidate(length));
    const input = values.map(value => `AKID1234567890123:${value}`).join('\n');

    expect(maskString(input, allRules)).toBe([
      `[ACCESSKEY_MASKED]:${values[0]}`,
      '[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]',
      '[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]',
      `[ACCESSKEY_MASKED]:${values[3]}`,
    ].join('\n'));
  });

  it('requires uppercase, lowercase, and a digit in each Secret candidate', () => {
    const candidates = ['abc123'.repeat(4), 'ABC123'.repeat(4), 'AbCdEf'.repeat(4)];
    const input = candidates.map(candidate => `AKID1234567890123:${candidate}`).join('\n');

    expect(maskString(input, allRules)).toBe(
      candidates.map(candidate => `[ACCESSKEY_MASKED]:${candidate}`).join('\n'),
    );
  });

  it('recognizes common separators and base64-like characters in Secret candidates', () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==';
    const input = [
      `LTAI1234567890ABCD:${secret};`,
      `AKIA1234567890ABCDEF ${secret}`,
      `AKID1234567890123\n${secret}`,
    ].join('\n');
    const masked = maskString(input, allRules);

    expect(masked.match(/\[ACCESSKEY_SECRET_MASKED\]/g)).toHaveLength(3);
    expect(masked).not.toContain(secret);
    expect(masked).toContain('[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED];');
  });

  it('recognizes a Secret that starts with a slash, plus, or hyphen after the ID', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const inputs = ['/', '+', '-'].map(separator =>
      `AKIA1234567890ABCDEF${separator}${secret}`,
    );

    expect(inputs.map(input => maskString(input, allRules))).toEqual(
      inputs.map(() => '[ACCESSKEY_MASKED][ACCESSKEY_SECRET_MASKED]'),
    );
  });

  it('finishes a Secret candidate at the next recognized AccessKey ID', () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const firstId = 'AKIA1234567890ABCDEF';
    const nextIds = ['LTAI1234567890ABCD', 'AKIA0987654321FEDCBA'];
    const inputs = [
      `${firstId} ${secret}=${nextIds[0]}`,
      `${firstId} ${secret}+${nextIds[1]}`,
    ];

    expect(inputs.map(input => maskString(input, allRules))).toEqual([
      `[ACCESSKEY_MASKED] [ACCESSKEY_SECRET_MASKED][ACCESSKEY_MASKED]`,
      `[ACCESSKEY_MASKED] [ACCESSKEY_SECRET_MASKED][ACCESSKEY_MASKED]`,
    ]);
  });

  it('scans no more than 1024 characters after an access key ID', () => {
    const secret = 'Aa1'.repeat(13) + 'A';
    const inRange = `AKID1234567890123${' '.repeat(984)}${secret}`;
    const outOfRange = `AKID1234567890123${' '.repeat(985)}${secret}`;

    expect(maskString(inRange, allRules)).toContain('[ACCESSKEY_SECRET_MASKED]');
    expect(maskString(outOfRange, allRules)).toBe(
      `[ACCESSKEY_MASKED]${' '.repeat(985)}${secret}`,
    );
  });

  it('finds a Secret in large text even when it is outside the generic keyword window', () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const input = `${'x'.repeat(200)} LTAI1234567890ABCD${' '.repeat(200)}${secret} ${'y'.repeat(200)}`;
    const masked = maskString(input, allRules, {
      largeStringThresholdBytes: 64,
      keywordContextWindow: 8,
    });

    expect(masked).toContain('[ACCESSKEY_MASKED]');
    expect(masked).toContain('[ACCESSKEY_SECRET_MASKED]');
    expect(masked).not.toContain(secret);
  });

  it('uses the configured masked preview format for a recognized nearby Secret', () => {
    const plan = loadMaskPlan({ mode: 'all', types: [], replacementMode: 'preview' });
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==';
    const masked = maskString(`AKIA1234567890ABCDEF:${secret}`, plan);

    expect(masked).toContain('[ACCESSKEY_MASKED]{AKIA************CDEF}');
    expect(masked).toMatch(/\[ACCESSKEY_SECRET_MASKED\]\{AbCd\*+_-==\}/);
    expect(masked).not.toContain(secret);
  });

  it('keeps Secret placeholder and preview markers stable when masking again', () => {
    const placeholder = '[ACCESSKEY_SECRET_MASKED]';
    const preview = '[ACCESSKEY_SECRET_MASKED]{AbCd********7890}';

    expect(maskString(placeholder, allRules)).toBe(placeholder);
    expect(maskString(preview, allRules)).toBe(preview);
  });

  it('masks all supported GitHub token prefixes', () => {
    const tokens = [
      'ghp_1234567890abcdefghijklmnop',
      'gho_1234567890abcdefghijklmnop',
      'ghu_1234567890abcdefghijklmnop',
      'ghs_1234567890abcdefghijklmnop',
      'ghr_1234567890abcdefghijklmnop',
      'github_pat_1234567890abcdefghijklmnop',
    ];

    const masked = maskString(tokens.join('\n'), allRules);

    expect(masked.match(/\[APIKEY_MASKED\]/g)).toHaveLength(tokens.length);
    for (const token of tokens) {
      expect(masked).not.toContain(token);
    }
  });

  it('does not mask secret-like substrings that fail boundaries or minimum lengths', () => {
    const input = [
      'embedded_aws=xxAKIAIOSFODNN7EXAMPLEyy',
      'embedded_api=xxsk-1234567890abcdefghijklmnopxx',
      'short_aliyun=LTAI123',
      'short_aws=AKIA123',
      'short_tencent=AKIDshort',
      'short_api=sk-short',
      'short_github=github_pat_short',
    ].join('\n');

    expect(maskString(input, allRules)).toBe(input);
  });

  it('does not mask unsupported API key prefixes or generic key-value pairs', () => {
    const input = [
      'google=AIzaSyA0FakeGoogleKeyShouldRemainVisible',
      'unsupported_github=ghx_1234567890abcdefghijklmnop',
      'generic_token=token=abc123',
      'generic_api_key=api_key=not-a-real-key-value',
      'bearer=Bearer abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n');

    expect(maskString(input, allRules)).toBe(input);
  });

  it('masks private key blocks', () => {
    const input = [
      'before',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
      '-----END OPENSSH PRIVATE KEY-----',
      'after',
    ].join('\n');

    const masked = maskString(input, allRules);

    expect(masked).toBe('before\n[PRIVATEKEY_MASKED]\nafter');
  });

  it('masks database URLs that include passwords', () => {
    const input = [
      'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot',
      'postgres://agent:PostgresPass123@127.0.0.1:5432/pilot',
      'mongodb://agent:MongoPass123@127.0.0.1:27017/pilot',
      'redis://:RedisPass123@127.0.0.1:6379/0',
      'jdbc:mysql://localhost:3306/db?useSSL=false&user=root&password=MySynthMysql12',
      'jdbc:postgresql://localhost:5432/mydb?user=u&pwd=secret123',
    ].join('\n');

    const masked = maskString(input, allRules);

    expect(masked.match(/\[DATABASEURL_MASKED\]/g)).toHaveLength(6);
    expect(masked).not.toContain('eMCyjl4XWcVzpXFb');
    expect(masked).not.toContain('PostgresPass123');
    expect(masked).not.toContain('MongoPass123');
    expect(masked).not.toContain('RedisPass123');
    expect(masked).not.toContain('MySynthMysql12');
    expect(masked).not.toContain('secret123');
  });

  it('preserves natural-language suffix after a masked JDBC database URL', () => {
    const input =
      'MASK_TEST_009 jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12你能识别到多少';

    expect(maskString(input, allRules)).toBe(
      'MASK_TEST_009 [DATABASEURL_MASKED]你能识别到多少',
    );
  });

  it('does not mask database URLs without passwords', () => {
    const input = [
      'mysql://localhost:3306/pilot',
      'mysql://agent@localhost:3306/pilot',
      'mysql://agent:@localhost:3306/pilot',
      'http://agent:HttpPass123@example.com/path',
      'jdbc:mysql://localhost:3306/db?useSSL=false&user=root',
      'jdbc:mysql://localhost:3306/db?user=root&password=',
      'jdbc:mysql://localhost:3306/db?user=root&passwordless=true',
    ].join('\n');

    expect(maskString(input, allRules)).toBe(input);
  });

  it('does not mask public keys, certificates, incomplete private keys, or oversized private key blocks', () => {
    const oversizedPrivateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'A'.repeat(70 * 1024),
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const input = [
      '-----BEGIN PUBLIC KEY-----',
      'PublicKeyMaterialOnly',
      '-----END PUBLIC KEY-----',
      '-----BEGIN CERTIFICATE-----',
      'CertificateMaterialOnly',
      '-----END CERTIFICATE-----',
      '-----BEGIN PRIVATE KEY-----',
      'IncompletePrivateKeyMaterialOnly',
      oversizedPrivateKey,
    ].join('\n');

    expect(maskString(input, allRules)).toBe(input);
  });

  it('uses UTF-8 byte length for large-string detection', () => {
    expect(isLargeString('你好abc', 8)).toBe(true);
    expect(isLargeString('hello', 8)).toBe(false);
  });

  it('does not mask already masked tokens again', () => {
    const input = '[APIKEY_MASKED] sk-1234567890abcdefghijklmnop';

    const masked = maskString(input, allRules);

    expect(masked).toBe('[APIKEY_MASKED] [APIKEY_MASKED]');
  });

  it('applies multiple unsorted ranges without changing untouched text', () => {
    const masked = applyMaskRanges('0123456789', [
      {
        start: 7,
        end: 9,
        replacement: '[SECOND]',
        ruleId: 'test.second',
        type: 'apiKey',
      },
      {
        start: 1,
        end: 3,
        replacement: '[FIRST]',
        ruleId: 'test.first',
        type: 'apiKey',
      },
    ]);

    expect(masked).toBe('0[FIRST]3456[SECOND]9');
  });

  it('keeps the full union covered across chained overlapping ranges', () => {
    const masked = applyMaskRanges('0123456789', [
      {
        start: 0,
        end: 5,
        replacement: '[EMAIL_MASKED]',
        ruleId: 'pii.email',
        type: 'email',
      },
      {
        start: 3,
        end: 8,
        replacement: '[PHONE_MASKED]',
        ruleId: 'pii.phone',
        type: 'phone',
      },
      {
        start: 7,
        end: 10,
        replacement: '[IDCARD_MASKED]',
        ruleId: 'pii.idCard',
        type: 'idCard',
      },
    ]);

    expect(masked).toBe('[IDCARD_MASKED]');
  });

  it('masks secrets in large strings through keyword windows', () => {
    const input = [
      'x'.repeat(120),
      ' LTAI1234567890ABCD ',
      'y'.repeat(20),
      ' sk-1234567890abcdefghijklmnop ',
      'z'.repeat(120),
    ].join('');

    const masked = maskString(input, allRules, {
      largeStringThresholdBytes: 64,
      keywordContextWindow: 32,
    });

    expect(masked).toContain('[ACCESSKEY_MASKED]');
    expect(masked).toContain('[APIKEY_MASKED]');
    expect(masked).not.toContain('LTAI1234567890ABCD');
    expect(masked).not.toContain('sk-1234567890abcdefghijklmnop');
  });
});
