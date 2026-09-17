import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { interceptorAccessLogPath } from './paths.js';
import type { HookRequest } from './types.js';

export const ACCESS_LOG_MAX_CHARS = 256_000;

export type AccessLogAction = 'allow' | 'block' | 'fail-open';

export interface InterceptorAccessInput {
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  cwd?: string;
  raw?: unknown;
  rawText?: string;
}

export interface InterceptorAccessResult {
  action: AccessLogAction;
  reason?: string;
  ruleId?: string;
  evaluatedRules?: string[];
  error?: string;
}

export interface InterceptorAccessLogEntry {
  ts: string;
  event: string;
  agent?: string;
  sessionId?: string;
  input: InterceptorAccessInput;
  result: InterceptorAccessResult;
}

export function accessInputFromHookRequest(request: HookRequest): InterceptorAccessInput {
  return {
    prompt: request.prompt,
    toolName: request.toolName,
    toolInput: request.toolInput,
    toolResponse: request.toolResponse,
    cwd: request.cwd,
    raw: request.raw,
  };
}

export function accessInputFromPayload(payload: Record<string, unknown>): InterceptorAccessInput {
  return {
    prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
    toolName: typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.toolName === 'string' ? payload.toolName : undefined,
    toolInput: payload.tool_input ?? payload.toolInput,
    toolResponse: payload.tool_response ?? payload.tool_output ?? payload.toolResponse,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    raw: payload,
  };
}

export function buildAccessLogEntry(
  partial: Omit<InterceptorAccessLogEntry, 'ts'> & { ts?: string },
): InterceptorAccessLogEntry {
  return {
    ts: partial.ts ?? new Date().toISOString(),
    event: partial.event,
    agent: partial.agent,
    sessionId: partial.sessionId,
    input: partial.input,
    result: partial.result,
  };
}

export function writeInterceptorAccessLog(
  entry: InterceptorAccessLogEntry,
  filePath?: string,
): void {
  try {
    const dest = filePath ?? interceptorAccessLogPath();
    mkdirSync(dirname(dest), { recursive: true });
    appendFileSync(dest, `${serializeAccessLogEntry(entry)}\n`, 'utf8');
  } catch {
    // Access logs must never affect fail-open or the host verdict.
  }
}

export function serializeAccessLogEntry(entry: InterceptorAccessLogEntry): string {
  const line = safeJson(entry);
  if (line.length <= ACCESS_LOG_MAX_CHARS) return line;
  return safeJson({
    ...entry,
    input: truncateInput(entry.input),
  });
}

function truncateInput(input: InterceptorAccessInput): InterceptorAccessInput {
  return {
    prompt: truncateString(input.prompt),
    toolName: input.toolName,
    toolInput: truncateUnknown(input.toolInput),
    toolResponse: truncateUnknown(input.toolResponse),
    cwd: input.cwd,
    raw: truncateUnknown(input.raw),
    rawText: truncateString(input.rawText),
  };
}

function truncateUnknown(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  const text = safeJson(value);
  if (text.length <= ACCESS_LOG_MAX_CHARS / 4) return value;
  return `${text.slice(0, ACCESS_LOG_MAX_CHARS / 4)}...<truncated>`;
}

function truncateString(value: string | undefined): string | undefined {
  if (value == null) return value;
  const limit = ACCESS_LOG_MAX_CHARS / 4;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...<truncated>`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ omitted: 'unserializable' }) ?? '{"omitted":"unserializable"}';
  }
}
