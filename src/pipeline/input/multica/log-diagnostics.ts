import type { MulticaRecord } from './types.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Diagnostic text is separate from low-cardinality event names. Do not export
// request payloads, prompts or tool results while retaining actionable errors.
const PRIVATE_KEY = /^(?:authorization|proxy.authorization|cookie|set.cookie|.*(?:password|secret|api.?key|access.?token|refresh.?token)|token|credentials?|private_key|custom_env|env|prompt|system_prompt|instructions|messages|payload|body|content|arguments|result|input|output|request|response|request_body|response_body)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH LIMIT]';
  if (Array.isArray(value)) return value.slice(0, 40).map(item => scrub(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80)
    .map(([key, item]) => [key, PRIVATE_KEY.test(key) ? '[REDACTED]' : scrub(item, depth + 1)]));
  return typeof value === 'string' ? redactText(value) : value;
}

function redactText(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[REDACTED]')
    .replace(/\b(?:sk-|mat_|mpt_|ghp_|github_pat_)[A-Za-z0-9_.-]+|\bLTAI[A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, url => url.replace(/(https?:\/\/)[^/@]+:[^/@]+@/i, '$1[REDACTED]@').replace(/[?#].*$/, '?[REDACTED]'))
    .replace(/((?:["']?)(?:authorization|proxy.authorization|cookie|set.cookie|[\w.-]*(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)|token)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    // Payloads embedded in prose may contain nested JSON, so discard the tail
    // instead of attempting to balance arbitrary free-form request content.
    .replace(/(["']?(?:prompt|system_prompt|messages|payload|body|request_body|response_body|custom_env)["']?\s*[=:]\s*)[^\n]*/gi, '$1[REDACTED]');
}

export function diagnosticText(value: unknown, maxBytes = 4096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let text: string;
  if (typeof value === 'object') text = JSON.stringify(scrub(value));
  else {
    text = String(value);
    try { text = JSON.stringify(scrub(JSON.parse(text))); } catch { text = redactText(text); }
  }
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // Bound UTF-8 bytes, keeping a visible marker and avoiding split code points.
  const suffix = '\n[TRUNCATED]';
  const part = Buffer.from(text).subarray(0, maxBytes - Buffer.byteLength(suffix)).toString('utf8').replace(/\uFFFD$/, '');
  return part + suffix;
}

export function logDiagnostics(fields: Record<string, unknown>, message: string): MulticaRecord {
  const error = object(fields.error ?? fields.err ?? fields.exception);
  const candidates: Record<string, unknown> = {
    log_message: message,
    error_message: fields.error ?? fields.err ?? fields.exception,
    error_code: fields.error_code ?? error.code ?? object(fields.exception).code ?? fields.code,
    error_stack: fields.stack ?? fields.stacktrace ?? fields.stack_trace ?? fields['exception.stacktrace'] ?? error.stack ?? error.stacktrace,
    stderr: fields.stderr ?? fields.stderr_tail,
    exit_code: fields.exit_code ?? error.exit_code ?? error.exitCode,
  };
  const out: MulticaRecord = {};
  for (const [key, value] of Object.entries(candidates)) {
    const text = diagnosticText(value, key === 'error_stack' ? 8192 : 4096);
    if (text !== undefined) out[key] = text;
  }
  if (Object.values(out).some(value => value.endsWith('[TRUNCATED]'))) out.log_content_truncated = 'true';
  return out;
}
