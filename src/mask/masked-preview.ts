import type {
  MaskReplacementMode,
  MaskType,
} from '../types/index.js';

export const MAX_MASKED_PREVIEW_LENGTH = 512;

const API_KEY_PREFIXES = [
  'github_pat_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'sk-',
] as const;

/**
 * Build the final replacement only after a detector has confirmed the type.
 * Any malformed or unexpectedly large preview falls back to the existing marker.
 */
export function buildMaskReplacement(
  marker: string,
  type: MaskType,
  rawValue: string,
  mode: MaskReplacementMode,
): string {
  if (mode !== 'preview') return marker;

  try {
    const preview = buildMaskedPreview(type, rawValue);
    if (
      !preview ||
      preview.length > MAX_MASKED_PREVIEW_LENGTH ||
      /[{}\r\n]/.test(preview)
    ) {
      return marker;
    }
    return `${marker}{${preview}}`;
  } catch {
    return marker;
  }
}

function buildMaskedPreview(type: MaskType, rawValue: string): string | null {
  switch (type) {
    case 'cloudAccessKey':
      return maskMiddle(rawValue, 4, 4);
    case 'apiKey':
      return maskApiKey(rawValue);
    case 'privateKey':
      return maskPrivateKey(rawValue);
    case 'databaseUrl':
      return maskDatabaseUrl(rawValue);
    case 'idCard':
      return maskMiddle(rawValue, 4, 4);
    case 'phone':
      return maskPhone(rawValue);
    case 'email':
      return maskEmail(rawValue);
    case 'ipAddress':
      return maskIpv4(rawValue);
    case 'bankCard':
      return maskBankCard(rawValue);
  }
}

function maskApiKey(value: string): string {
  const normalized = value.toLowerCase();
  const prefix = API_KEY_PREFIXES.find(candidate => normalized.startsWith(candidate));
  if (!prefix) return maskMiddle(value, 2, 4);

  const body = value.slice(prefix.length);
  return `${value.slice(0, prefix.length)}${maskMiddle(body, 1, 4)}`;
}

function maskPhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('0086') && digits.length === 15) {
    digits = digits.slice(4);
  } else if (digits.startsWith('86') && digits.length === 13) {
    digits = digits.slice(2);
  }

  if (/^1[3-9]\d{9}$/.test(digits)) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  if (!/^0\d{9,11}$/.test(digits)) return null;
  const formattedArea = value.match(/^\((0\d{2,3})\)|^(0\d{2,3})-/);
  const areaCode = formattedArea?.[1] ?? formattedArea?.[2] ??
    digits.slice(0, digits.length >= 12 ? 4 : 3);
  const subscriberLength = digits.length - areaCode.length;
  if (subscriberLength < 5) return null;
  return `${areaCode}${'*'.repeat(subscriberLength - 4)}${digits.slice(-4)}`;
}

function maskBankCard(value: string): string | null {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{15,19}$/.test(digits)) return null;
  return maskMiddle(digits, 6, 4);
}

function maskEmail(value: string): string | null {
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex + 1 >= value.length) return null;

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1).toLowerCase();
  let maskedLocal: string;
  if (local.length >= 6) {
    maskedLocal = maskMiddle(local, 2, 2);
  } else if (local.length >= 3) {
    maskedLocal = maskMiddle(local, 1, 1);
  } else if (local.length === 2) {
    maskedLocal = `${local[0]}*`;
  } else {
    maskedLocal = `${local}*`;
  }
  return `${maskedLocal}@${domain}`;
}

function maskIpv4(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  return `${parts[0]}.*.*.${parts[3]}`;
}

function maskPrivateKey(value: string): string | null {
  const match = value.match(
    /^-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----$/,
  );
  if (!match) return null;

  const keyType = match[1].trim();
  const body = match[2].replace(/\s/g, '');
  if (body.length < 8) return null;
  return `${keyType}:${body.slice(0, 4)}********${body.slice(-4)}`;
}

function maskDatabaseUrl(value: string): string | null {
  if (/^jdbc:/i.test(value)) return maskJdbcUrl(value);

  try {
    const parsed = new URL(value);
    const username = parsed.username;
    const userInfo = username || parsed.password
      ? `${username}:****@`
      : '';
    const hostname = maskIpv4(parsed.hostname) ?? parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${userInfo}${hostname}${port}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function maskJdbcUrl(value: string): string | null {
  const parameterIndex = value.search(/[?;]/);
  const withoutParameters = parameterIndex === -1 ? value : value.slice(0, parameterIndex);
  const match = withoutParameters.match(/^(jdbc:(?:mysql|postgresql):\/\/)([^/]+)(\/.*)?$/i);
  if (!match) return null;

  const prefix = match[1];
  const authority = maskDatabaseAuthority(match[2]);
  const path = match[3] ?? '';
  return `${prefix}${authority}${path}`;
}

function maskDatabaseAuthority(authority: string): string {
  const atIndex = authority.lastIndexOf('@');
  const rawHost = atIndex === -1 ? authority : authority.slice(atIndex + 1);
  const rawUserInfo = atIndex === -1 ? '' : authority.slice(0, atIndex);
  const username = rawUserInfo.includes(':')
    ? rawUserInfo.slice(0, rawUserInfo.indexOf(':'))
    : rawUserInfo;

  const hostMatch = rawHost.match(/^(\d{1,3}(?:\.\d{1,3}){3})(:\d+)?$/);
  const host = hostMatch
    ? `${maskIpv4(hostMatch[1]) ?? hostMatch[1]}${hostMatch[2] ?? ''}`
    : rawHost;
  return rawUserInfo ? `${username}:****@${host}` : host;
}

function maskMiddle(value: string, keepStart: number, keepEnd: number): string {
  if (value.length > keepStart + keepEnd) {
    return `${value.slice(0, keepStart)}${'*'.repeat(
      value.length - keepStart - keepEnd,
    )}${value.slice(-keepEnd)}`;
  }
  if (value.length >= 5) {
    return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
  }
  if (value.length >= 3) {
    return `${value[0]}${'*'.repeat(value.length - 2)}${value[value.length - 1]}`;
  }
  if (value.length === 2) return `${value[0]}*`;
  return `${value}*`;
}
