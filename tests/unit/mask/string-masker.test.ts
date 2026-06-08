import { describe, expect, it } from 'vitest';

import { loadEnabledRules } from '../../../src/mask/rule-loader.js';
import { isLargeString, maskString } from '../../../src/mask/string-masker.js';
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
