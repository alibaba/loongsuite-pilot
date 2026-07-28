import { describe, expect, it } from 'vitest';

import { loadMaskPlan } from '../../../src/mask/rule-loader.js';
import { applyMaskRanges, maskString } from '../../../src/mask/string-masker.js';
import type { PiiMaskType } from '../../../src/mask/types.js';
import type { MaskType } from '../../../src/types/index.js';

const ALL_PII_TYPES: PiiMaskType[] = [
  'idCard',
  'phone',
  'email',
  'ipAddress',
  'bankCard',
];

function mask(value: string, types: MaskType[] = ALL_PII_TYPES): string {
  return maskString(
    value,
    loadMaskPlan({
      mode: 'custom',
      types,
    }),
  );
}

function buildIdCard(first17: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const sum = [...first17].reduce(
    (total, digit, index) => total + Number(digit) * weights[index],
    0,
  );
  return `${first17}${checks[sum % 11]}`;
}

describe('PII mask detectors', () => {
  it('masks valid mainland China ID cards after strict validation', () => {
    const knownIdCard = '11010519491231002X';
    const lowerCaseCheck = `${knownIdCard.slice(0, -1)}x`;

    expect(mask(`id=${knownIdCard} lower=${lowerCaseCheck}`, ['idCard'])).toBe(
      'id=[IDCARD_MASKED] lower=[IDCARD_MASKED]',
    );
  });

  it('rejects invalid ID card province, date, sequence, checksum, and boundaries', () => {
    const futureYear = new Date().getFullYear() + 1;
    const valid = buildIdCard('11010520000101001');
    const invalidCandidates = [
      buildIdCard('99010520000101001'),
      buildIdCard('11010520001301001'),
      buildIdCard(`${`110105${futureYear}`.slice(0, 10)}0101001`),
      buildIdCard('11010520000101000'),
      `${valid.slice(0, -1)}${valid.endsWith('0') ? '1' : '0'}`,
      `A${valid}B`,
      '130503670401001',
    ];
    const input = invalidCandidates.join('|');

    expect(mask(input, ['idCard'])).toBe(input);
  });

  it('masks mainland China mobile and landline formats', () => {
    const phones = [
      '13800138000',
      '+86 138 0013 8000',
      '0086-138-0013-8000',
      '010-12345678',
      '(010)12345678',
      '057112345678',
    ];
    const masked = mask(phones.join('|'), ['phone']);

    expect(masked.match(/\[PHONE_MASKED\]/g)).toHaveLength(phones.length);
    for (const phone of phones) {
      expect(masked).not.toContain(phone);
    }
  });

  it('masks adjacent phone candidates separated only by whitespace', () => {
    expect(mask('13800138000 13900139000', ['phone'])).toBe(
      '[PHONE_MASKED] [PHONE_MASKED]',
    );
  });

  it('rejects invalid, service, extension, overseas, and embedded phone formats', () => {
    const invalidPhones = [
      '12800138000',
      '4008001234',
      '8001234567',
      '+1-202-555-0123',
      '010-12345678-123',
      '001-12345678',
      '(001)12345678',
      'A13800138000B',
    ];
    const input = invalidPhones.join('|');

    expect(mask(input, ['phone'])).toBe(input);
  });

  it('masks common ASCII emails and preserves trailing punctuation', () => {
    const input = 'primary=user.name+tag@example-domain.com, backup=a_b@example.co.';

    expect(mask(input, ['email'])).toBe(
      'primary=[EMAIL_MASKED], backup=[EMAIL_MASKED].',
    );
  });

  it('rejects malformed and out-of-scope emails', () => {
    const invalidEmails = [
      '.user@example.com',
      'user..name@example.com',
      'user@example-.com',
      'user@localhost',
      'user@example.c',
      'user@example.com_',
      '中文@example.com',
      'a@b@c.com',
    ];
    const input = invalidEmails.join('|');

    expect(mask(input, ['email'])).toBe(input);
  });

  it('masks public, private, loopback, and link-local IPv4 addresses', () => {
    const input = '8.8.8.8|192.168.1.10|127.0.0.1|169.254.10.20.';

    expect(mask(input, ['ipAddress'])).toBe(
      '[IPADDRESS_MASKED]|[IPADDRESS_MASKED]|[IPADDRESS_MASKED]|[IPADDRESS_MASKED].',
    );
  });

  it('rejects malformed IPv4 addresses but accepts a valid version-shaped address', () => {
    const invalid = '256.1.1.1|192.168.01.1|1.2.3|1.2.3.4.5';
    expect(mask(invalid, ['ipAddress'])).toBe(invalid);
    expect(mask('version=1.2.3.4', ['ipAddress'])).toBe(
      'version=[IPADDRESS_MASKED]',
    );
  });

  it('masks supported card issuers after Luhn validation', () => {
    const cards = [
      '6221 2600 0000 0000',
      '4111111111111111',
      '5555-5555-5555-4444',
      '378282246310005',
      '6011111111111117',
    ];
    const masked = mask(cards.join('|'), ['bankCard']);

    expect(masked.match(/\[BANKCARD_MASKED\]/g)).toHaveLength(cards.length);
    for (const card of cards) {
      expect(masked).not.toContain(card);
    }
  });

  it('rejects bank card candidates with invalid prefix, Luhn, length, or boundaries', () => {
    const invalidCards = [
      '4111111111111112',
      '9111111111111111',
      '41111111111111',
      'A4111111111111111B',
    ];
    const input = invalidCards.join('|');

    expect(mask(input, ['bankCard'])).toBe(input);
  });

  it('only runs PII detectors selected by custom mode', () => {
    const input = 'email=user@example.com phone=13800138000';

    expect(mask(input, ['email'])).toBe(
      'email=[EMAIL_MASKED] phone=13800138000',
    );
  });

  it('uses deterministic overlap priority for numeric PII ranges', () => {
    const value = '123456789012345678';
    const masked = applyMaskRanges(value, [
      {
        start: 0,
        end: value.length,
        replacement: '[PHONE_MASKED]',
        ruleId: 'pii.phone',
        type: 'phone',
      },
      {
        start: 0,
        end: value.length,
        replacement: '[BANKCARD_MASKED]',
        ruleId: 'pii.bankCard',
        type: 'bankCard',
      },
      {
        start: 0,
        end: value.length,
        replacement: '[IDCARD_MASKED]',
        ruleId: 'pii.idCard',
        type: 'idCard',
      },
    ]);

    expect(masked).toBe('[IDCARD_MASKED]');
  });

  it('keeps existing broad secret rules ahead of nested PII matches', () => {
    const value = 'mysql://agent:secret@example.com:3306/db';

    expect(
      maskString(value, loadMaskPlan({ mode: 'all', types: [] })),
    ).toBe('[DATABASEURL_MASKED]');
  });

  it('preserves existing markers and rejects overlong numeric candidates', () => {
    const overlongCandidate = '4'.repeat(1_000);
    const input = `[PHONE_MASKED]|${overlongCandidate}`;

    expect(mask(input)).toBe(input);
  });

  it('masks valid candidates at string boundaries and beside Unicode text', () => {
    expect(mask('13800138000中文user@example.com', ['phone', 'email'])).toBe(
      '[PHONE_MASKED]中文[EMAIL_MASKED]',
    );
  });

  it('masks PII in large text using the same bounded detector path', () => {
    const phone = '13800138000';
    const input = `${'x'.repeat(80 * 1024)} ${phone} ${'y'.repeat(80 * 1024)}`;
    const plan = loadMaskPlan({ mode: 'custom', types: ['phone'] });
    const masked = maskString(input, plan, {
      largeStringThresholdBytes: 64 * 1024,
    });

    expect(masked).toContain('[PHONE_MASKED]');
    expect(masked).not.toContain(phone);
  });
});
