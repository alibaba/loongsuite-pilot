import type { MaskRange, PiiMaskType } from './types.js';

const MAX_PHONE_CANDIDATE_LENGTH = 18;
const MAX_BANK_CARD_CANDIDATE_LENGTH = 37;
const MAX_EMAIL_LENGTH = 254;
const MAX_EMAIL_LOCAL_LENGTH = 64;
const MAX_EMAIL_DOMAIN_LABEL_LENGTH = 63;
const ASCII_DIGIT_PATTERN = /[0-9]/;

const ID_CARD_PROVINCE_CODES = new Set([
  '11', '12', '13', '14', '15',
  '21', '22', '23',
  '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46',
  '50', '51', '52', '53', '54',
  '61', '62', '63', '64', '65',
]);
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECKSUM = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

const REPLACEMENTS: Record<PiiMaskType, string> = {
  idCard: '[IDCARD_MASKED]',
  phone: '[PHONE_MASKED]',
  email: '[EMAIL_MASKED]',
  ipAddress: '[IPADDRESS_MASKED]',
  bankCard: '[BANKCARD_MASKED]',
};

export function collectPiiRanges(
  value: string,
  enabledTypes: ReadonlySet<PiiMaskType>,
): MaskRange[] {
  if (value.length === 0 || enabledTypes.size === 0) return [];

  const ranges: MaskRange[] = [];
  const detectIdCard = enabledTypes.has('idCard');
  const detectPhone = enabledTypes.has('phone');
  const detectBankCard = enabledTypes.has('bankCard');
  const detectIpAddress = enabledTypes.has('ipAddress');
  const detectNumericPii = detectIdCard || detectPhone || detectBankCard;
  const hasAsciiDigit =
    (detectNumericPii || detectIpAddress) && ASCII_DIGIT_PATTERN.test(value);

  if (detectNumericPii && hasAsciiDigit) {
    collectNumericRanges(value, ranges, {
      idCard: detectIdCard,
      phone: detectPhone,
      bankCard: detectBankCard,
    });
  }
  if (enabledTypes.has('email') && value.includes('@')) {
    collectEmailRanges(value, ranges);
  }
  if (detectIpAddress && hasAsciiDigit && value.includes('.')) {
    collectIpAddressRanges(value, ranges);
  }

  return ranges;
}

function collectNumericRanges(
  value: string,
  ranges: MaskRange[],
  enabled: { idCard: boolean; phone: boolean; bankCard: boolean },
): void {
  let candidateStart = -1;
  const currentDateNumber = enabled.idCard ? getCurrentDateNumber() : 0;
  const detectFormattedNumeric = enabled.phone || enabled.bankCard;

  for (let index = 0; index <= value.length; index += 1) {
    const code = index < value.length ? value.charCodeAt(index) : -1;

    if (
      enabled.idCard &&
      isAsciiDigit(code) &&
      (index === 0 || !isAsciiAlphaNumeric(value.charCodeAt(index - 1)))
    ) {
      collectIdCardAt(value, index, ranges, currentDateNumber);
    }

    if (index < value.length && isNumericCandidateChar(code)) {
      if (candidateStart === -1 && isNumericCandidateStart(code)) {
        candidateStart = index;
      }
      continue;
    }

    if (candidateStart !== -1 && detectFormattedNumeric) {
      collectFormattedNumericCandidate(
        value,
        candidateStart,
        index,
        ranges,
        enabled.phone,
        enabled.bankCard,
      );
    }
    candidateStart = -1;
  }
}

function collectIdCardAt(
  value: string,
  start: number,
  ranges: MaskRange[],
  currentDateNumber: number,
): void {
  const end = start + 18;
  if (end > value.length) return;
  if (end < value.length && isAsciiAlphaNumeric(value.charCodeAt(end))) return;

  for (let index = start; index < start + 17; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) return;
  }
  const lastCode = value.charCodeAt(start + 17);
  if (!isAsciiDigit(lastCode) && lastCode !== 88 && lastCode !== 120) return;

  const candidate = value.slice(start, end);
  if (!isValidIdCard(candidate, currentDateNumber)) return;
  ranges.push(createRange(start, end, 'idCard'));
}

function getCurrentDateNumber(): number {
  const currentDate = new Date();
  return (
    currentDate.getFullYear() * 10_000 +
    (currentDate.getMonth() + 1) * 100 +
    currentDate.getDate()
  );
}

function isValidIdCard(candidate: string, currentDateNumber: number): boolean {
  if (!ID_CARD_PROVINCE_CODES.has(candidate.slice(0, 2))) return false;

  const year = Number(candidate.slice(6, 10));
  const month = Number(candidate.slice(10, 12));
  const day = Number(candidate.slice(12, 14));
  const dateNumber = year * 10_000 + month * 100 + day;
  if (
    year < 1900 ||
    dateNumber > currentDateNumber ||
    !isValidCalendarDate(year, month, day)
  ) {
    return false;
  }
  if (candidate.slice(14, 17) === '000') return false;

  let weightedSum = 0;
  for (let index = 0; index < 17; index += 1) {
    weightedSum += (candidate.charCodeAt(index) - 48) * ID_CARD_WEIGHTS[index];
  }
  return candidate[17].toUpperCase() === ID_CARD_CHECKSUM[weightedSum % 11];
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function collectFormattedNumericCandidate(
  value: string,
  rawStart: number,
  rawEnd: number,
  ranges: MaskRange[],
  detectPhone: boolean,
  detectBankCard: boolean,
): void {
  const end = trimNumericCandidateEnd(value, rawStart, rawEnd);
  const firstCode = value.charCodeAt(rawStart);
  const initialPhoneCandidate = detectPhone && isPotentialPhoneStart(firstCode);
  const initialBankCardCandidate =
    detectBankCard && isPotentialBankCardStart(firstCode);
  const maxCandidateLength = initialBankCardCandidate
    ? MAX_BANK_CARD_CANDIDATE_LENGTH
    : MAX_PHONE_CANDIDATE_LENGTH;
  const fullCandidateWithinLimit = end - rawStart <= maxCandidateLength;
  if (
    (initialPhoneCandidate || initialBankCardCandidate) &&
    fullCandidateWithinLimit &&
    collectValidatedNumericRange(
      value,
      rawStart,
      end,
      ranges,
      initialPhoneCandidate,
      initialBankCardCandidate,
    )
  ) {
    return;
  }

  let start = rawStart;
  while (start < end) {
    const startCode = value.charCodeAt(start);
    const possiblePhone = detectPhone && isPotentialPhoneStart(startCode);
    const possibleBankCard =
      detectBankCard && isPotentialBankCardStart(startCode);
    const boundedEnd = Math.min(
      end,
      start + (
        possibleBankCard
          ? MAX_BANK_CARD_CANDIDATE_LENGTH
          : MAX_PHONE_CANDIDATE_LENGTH
      ),
    );
    let digitCount = 0;
    for (let subEnd = start + 1; subEnd <= boundedEnd; subEnd += 1) {
      if (isAsciiDigit(value.charCodeAt(subEnd - 1))) {
        digitCount += 1;
      }
      const isCandidateEnd =
        subEnd === end ||
        (
          value.charCodeAt(subEnd) === 32 &&
          isNumericCandidateStart(value.charCodeAt(subEnd - 1))
        );
      if (
        !isCandidateEnd ||
        (fullCandidateWithinLimit && start === rawStart && subEnd === end)
      ) {
        continue;
      }
      const validatePhone =
        possiblePhone && isPotentialPhoneDigitCount(startCode, digitCount);
      const validateBankCard =
        possibleBankCard && digitCount >= 15 && digitCount <= 19;
      if (!validatePhone && !validateBankCard) continue;

      collectValidatedNumericRange(
        value,
        start,
        subEnd,
        ranges,
        validatePhone,
        validateBankCard,
      );
    }

    let separator = value.indexOf(' ', start);
    while (
      separator !== -1 &&
      separator + 1 < end &&
      !isNumericCandidateStart(value.charCodeAt(separator + 1))
    ) {
      separator = value.indexOf(' ', separator + 1);
    }
    if (separator === -1 || separator + 1 >= end) break;
    start = separator + 1;
  }
}

function isPotentialPhoneStart(code: number): boolean {
  return code === 40 || code === 43 || code === 48 || code === 49;
}

function isPotentialPhoneDigitCount(startCode: number, digitCount: number): boolean {
  if (startCode === 43) return digitCount === 13;
  if (startCode === 49) return digitCount === 11;
  if (startCode === 48) {
    return (digitCount >= 10 && digitCount <= 12) || digitCount === 15;
  }
  return startCode === 40 && digitCount >= 10 && digitCount <= 12;
}

function isPotentialBankCardStart(code: number): boolean {
  return code >= 50 && code <= 54;
}

function collectValidatedNumericRange(
  value: string,
  start: number,
  end: number,
  ranges: MaskRange[],
  detectPhone: boolean,
  detectBankCard: boolean,
): boolean {
  if (end <= start) return false;
  if (
    (start > 0 && isAsciiAlphaNumeric(value.charCodeAt(start - 1))) ||
    (end < value.length && isAsciiAlphaNumeric(value.charCodeAt(end)))
  ) {
    return false;
  }

  const candidate = value.slice(start, end);
  let matched = false;
  if (detectPhone && isValidPhone(candidate)) {
    ranges.push(createRange(start, end, 'phone'));
    matched = true;
  }
  if (detectBankCard && isValidBankCard(candidate)) {
    ranges.push(createRange(start, end, 'bankCard'));
    matched = true;
  }
  return matched;
}

function trimNumericCandidateEnd(value: string, start: number, rawEnd: number): number {
  let end = rawEnd;
  while (end > start && isTrimmableNumericSuffix(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return end;
}

function isValidPhone(candidate: string): boolean {
  if (candidate.length < 10 || candidate.length > MAX_PHONE_CANDIDATE_LENGTH) {
    return false;
  }

  if (candidate.includes('(') || candidate.includes(')')) {
    return /^\(0[1-9]\d{1,2}\)[ -]?\d{7,8}$/.test(candidate);
  }

  if (!hasValidSimpleSeparators(candidate, true)) return false;
  const compact = candidate.replace(/[ -]/g, '');

  if (/^1[3-9]\d{9}$/.test(compact)) return true;
  if (/^\+861[3-9]\d{9}$/.test(compact)) return true;
  if (/^00861[3-9]\d{9}$/.test(compact)) return true;

  if (compact[0] !== '0' || compact[1] === '0') return false;
  return /^0\d{2,3}\d{7,8}$/.test(compact);
}

function isValidBankCard(candidate: string): boolean {
  if (!hasValidSimpleSeparators(candidate, false)) return false;
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 15 || digits.length > 19 || !isAllAsciiDigits(digits)) {
    return false;
  }
  if (!matchesCardIssuer(digits)) return false;
  return passesLuhn(digits);
}

function hasValidSimpleSeparators(candidate: string, allowLeadingPlus: boolean): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (isAsciiDigit(code)) continue;
    if (allowLeadingPlus && code === 43 && index === 0) continue;
    if (code !== 32 && code !== 45) return false;
    if (
      index === 0 ||
      index + 1 >= candidate.length ||
      !isAsciiDigit(candidate.charCodeAt(index - 1)) ||
      !isAsciiDigit(candidate.charCodeAt(index + 1))
    ) {
      return false;
    }
  }
  return true;
}

function matchesCardIssuer(digits: string): boolean {
  const length = digits.length;
  const prefix2 = Number(digits.slice(0, 2));
  const prefix4 = Number(digits.slice(0, 4));

  if (digits[0] === '4') return length >= 16 && length <= 19;
  if (prefix2 >= 51 && prefix2 <= 55) return length === 16;
  if (prefix4 >= 2221 && prefix4 <= 2720) return length === 16;
  if (prefix2 === 34 || prefix2 === 37) return length === 15;
  if (digits.startsWith('6011') || digits.startsWith('65')) {
    return length >= 16 && length <= 19;
  }
  return prefix2 === 62 && length >= 16 && length <= 19;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function collectEmailRanges(value: string, ranges: MaskRange[]): void {
  let atIndex = value.indexOf('@');
  while (atIndex !== -1) {
    let start = atIndex;
    while (
      start > 0 &&
      atIndex - start < MAX_EMAIL_LOCAL_LENGTH + 1 &&
      isEmailLocalChar(value.charCodeAt(start - 1))
    ) {
      start -= 1;
    }

    let end = atIndex + 1;
    while (
      end < value.length &&
      end - start <= MAX_EMAIL_LENGTH &&
      isEmailDomainChar(value.charCodeAt(end))
    ) {
      end += 1;
    }
    while (end > atIndex + 1 && value.charCodeAt(end - 1) === 46) {
      end -= 1;
    }

    const localLength = atIndex - start;
    const stoppedByLocalLimit =
      start > 0 && isEmailLocalChar(value.charCodeAt(start - 1));
    const stoppedByTotalLimit =
      end < value.length &&
      isEmailDomainChar(value.charCodeAt(end)) &&
      value.charCodeAt(end) !== 46;
    const touchesAnotherAt =
      (start > 0 && value.charCodeAt(start - 1) === 64) ||
      (end < value.length && value.charCodeAt(end) === 64);
    const nextCode = end < value.length ? value.charCodeAt(end) : -1;
    const trailingPunctuationDot =
      nextCode === 46 &&
      (end + 1 >= value.length || !isEmailDomainChar(value.charCodeAt(end + 1)));
    const touchesEmailChar =
      isEmailLocalChar(nextCode) && !trailingPunctuationDot;

    if (
      localLength >= 1 &&
      localLength <= MAX_EMAIL_LOCAL_LENGTH &&
      end - start <= MAX_EMAIL_LENGTH &&
      !stoppedByLocalLimit &&
      !stoppedByTotalLimit &&
      !touchesAnotherAt &&
      !touchesEmailChar &&
      isValidEmail(value, start, atIndex, end)
    ) {
      ranges.push(createRange(start, end, 'email'));
    }

    atIndex = value.indexOf('@', atIndex + 1);
  }
}

function isValidEmail(value: string, start: number, atIndex: number, end: number): boolean {
  if (
    value.charCodeAt(start) === 46 ||
    value.charCodeAt(atIndex - 1) === 46
  ) {
    return false;
  }
  for (let index = start + 1; index < atIndex; index += 1) {
    if (value.charCodeAt(index) === 46 && value.charCodeAt(index - 1) === 46) {
      return false;
    }
  }

  const domain = value.slice(atIndex + 1, end);
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (
      label.length < 1 ||
      label.length > MAX_EMAIL_DOMAIN_LABEL_LENGTH ||
      !isAsciiLetterOrDigit(label.charCodeAt(0)) ||
      !isAsciiLetterOrDigit(label.charCodeAt(label.length - 1))
    ) {
      return false;
    }
    for (let index = 1; index < label.length - 1; index += 1) {
      const code = label.charCodeAt(index);
      if (!isAsciiLetterOrDigit(code) && code !== 45) return false;
    }
  }

  const topLevelDomain = labels[labels.length - 1];
  if (topLevelDomain.length < 2) return false;
  for (let index = 0; index < topLevelDomain.length; index += 1) {
    if (!isAsciiLetter(topLevelDomain.charCodeAt(index))) return false;
  }
  return true;
}

function collectIpAddressRanges(value: string, ranges: MaskRange[]): void {
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (
      !isAsciiDigit(code) ||
      (index > 0 && isDigitOrDot(value.charCodeAt(index - 1)))
    ) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < value.length && isDigitOrDot(value.charCodeAt(end))) {
      end += 1;
    }

    let candidateEnd = end;
    while (candidateEnd > index && value.charCodeAt(candidateEnd - 1) === 46) {
      candidateEnd -= 1;
    }
    if (
      candidateEnd - index >= 7 &&
      candidateEnd - index <= 15 &&
      isValidIpAddress(value, index, candidateEnd)
    ) {
      ranges.push(createRange(index, candidateEnd, 'ipAddress'));
    }
    index = end;
  }
}

function isValidIpAddress(value: string, start: number, end: number): boolean {
  let partCount = 0;
  let partValue = 0;
  let partLength = 0;
  let firstDigit = -1;

  for (let index = start; index <= end; index += 1) {
    const code = index < end ? value.charCodeAt(index) : 46;
    if (isAsciiDigit(code)) {
      if (partLength === 0) firstDigit = code;
      partLength += 1;
      if (partLength > 3) return false;
      partValue = partValue * 10 + code - 48;
      if (partValue > 255) return false;
      continue;
    }
    if (code !== 46 || partLength === 0) return false;
    if (partLength > 1 && firstDigit === 48) return false;
    partCount += 1;
    partValue = 0;
    partLength = 0;
    firstDigit = -1;
  }

  return partCount === 4;
}

function createRange(start: number, end: number, type: PiiMaskType): MaskRange {
  return {
    start,
    end,
    replacement: REPLACEMENTS[type],
    ruleId: `pii.${type}`,
    type,
  };
}

function isNumericCandidateStart(code: number): boolean {
  return isAsciiDigit(code) || code === 43 || code === 40;
}

function isNumericCandidateChar(code: number): boolean {
  return isAsciiDigit(code) || code === 32 || code === 43 || code === 45 || code === 40 || code === 41;
}

function isTrimmableNumericSuffix(code: number): boolean {
  return code === 32 || code === 45;
}

function isDigitOrDot(code: number): boolean {
  return isAsciiDigit(code) || code === 46;
}

function isEmailLocalChar(code: number): boolean {
  return (
    isAsciiLetterOrDigit(code) ||
    code === 37 ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 95
  );
}

function isEmailDomainChar(code: number): boolean {
  return isAsciiLetterOrDigit(code) || code === 45 || code === 46;
}

function isAllAsciiDigits(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) return false;
  }
  return true;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiLetterOrDigit(code);
}

function isAsciiLetterOrDigit(code: number): boolean {
  return isAsciiDigit(code) || isAsciiLetter(code);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
