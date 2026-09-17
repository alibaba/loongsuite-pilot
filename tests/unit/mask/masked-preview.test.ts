import { describe, expect, it } from 'vitest';

import { buildMaskReplacement } from '../../../src/mask/masked-preview.js';
import { loadMaskPlan } from '../../../src/mask/rule-loader.js';
import { maskString } from '../../../src/mask/string-masker.js';
import type { MaskConfig } from '../../../src/types/index.js';

const previewConfig: MaskConfig = {
  mode: 'all',
  types: [],
  replacementMode: 'preview',
};
const previewPlan = loadMaskPlan(previewConfig);

describe('masked preview replacement mode', () => {
  it('keeps placeholder output byte-compatible by default', () => {
    const plan = loadMaskPlan({
      mode: 'all',
      types: [],
      replacementMode: 'placeholder',
    });

    expect(maskString('phone=13800138000', plan)).toBe('phone=[PHONE_MASKED]');
    expect(maskString('mysql://agent:****@db.example.com/orders', plan)).toBe(
      '[DATABASEURL_MASKED]',
    );
  });

  it('builds stable previews for access keys and API keys', () => {
    const accessKey = 'LTAI1234567890ABCD';
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const masked = maskString(`${accessKey}|${apiKey}`, previewPlan);

    expect(masked).toBe(
      `[ACCESSKEY_MASKED]{LTAI${'*'.repeat(10)}ABCD}|` +
      `[APIKEY_MASKED]{sk-1${'*'.repeat(21)}mnop}`,
    );
  });

  it('builds a fixed-length private-key preview without line breaks', () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');

    expect(maskString(privateKey, previewPlan)).toBe(
      '[PRIVATEKEY_MASKED]{OPENSSH PRIVATE KEY:b3Bl********bmU=}',
    );
  });

  it('drops database query and fragment, masks password and nested IPv4', () => {
    const standard =
      'mysql://agent:secret@192.168.1.20:3306/orders?token=abc#debug';
    const jdbc =
      'jdbc:mysql://192.168.1.20:3306/orders?user=root&password=secret&token=abc';

    expect(maskString(`${standard}|${jdbc}`, previewPlan)).toBe(
      '[DATABASEURL_MASKED]{mysql://agent:****@192.*.*.20:3306/orders}|' +
      '[DATABASEURL_MASKED]{jdbc:mysql://192.*.*.20:3306/orders}',
    );
  });

  it('builds previews for ID card, email, IPv4 and bank card', () => {
    const input = [
      '11010519491231002X',
      'zhangsan@example.com',
      '192.168.1.10',
      '6221 2600 0000 0000',
    ].join('|');

    expect(maskString(input, previewPlan)).toBe(
      '[IDCARD_MASKED]{1101**********002X}|' +
      '[EMAIL_MASKED]{zh****an@example.com}|' +
      '[IPADDRESS_MASKED]{192.*.*.10}|' +
      '[BANKCARD_MASKED]{622126******0000}',
    );
  });

  it('normalizes equivalent mobile and landline formats before previewing', () => {
    const input = [
      '13800138000',
      '138-0013-8000',
      '+86 138 0013 8000',
      '010-12345678',
      '(010)12345678',
    ].join('|');

    expect(maskString(input, previewPlan)).toBe(
      [
        '[PHONE_MASKED]{138****8000}',
        '[PHONE_MASKED]{138****8000}',
        '[PHONE_MASKED]{138****8000}',
        '[PHONE_MASKED]{010****5678}',
        '[PHONE_MASKED]{010****5678}',
      ].join('|'),
    );
  });

  it('is idempotent for all generated preview token types', () => {
    const rawValues = [
      'LTAI1234567890ABCD',
      'sk-1234567890abcdefghijklmnop',
      [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
      'mysql://agent:secret@192.168.1.20:3306/orders?token=abc#debug',
      '11010519491231002X',
      '13800138000',
      'zhangsan@example.com',
      '192.168.1.10',
      '6221 2600 0000 0000',
    ];
    const once = rawValues.map(value => maskString(value, previewPlan)).join('|');

    expect(maskString(once, previewPlan)).toBe(once);
  });

  it('keeps old and preview tokens while masking new plaintext', () => {
    const existing = maskString('zhangsan@example.com', previewPlan);
    const input = `[PHONE_MASKED]|${existing}|13800138000`;

    expect(maskString(input, previewPlan)).toBe(
      `[PHONE_MASKED]|${existing}|[PHONE_MASKED]{138****8000}`,
    );
  });

  it('falls back to the fixed marker when a preview is unsafe or too long', () => {
    expect(
      buildMaskReplacement(
        '[DATABASEURL_MASKED]',
        'databaseUrl',
        `mysql://${'a'.repeat(600)}:secret@db.example.com/orders`,
        'preview',
      ),
    ).toBe('[DATABASEURL_MASKED]');
    expect(
      buildMaskReplacement(
        '[EMAIL_MASKED]',
        'email',
        'a@example.{com',
        'preview',
      ),
    ).toBe('[EMAIL_MASKED]');
  });
});
