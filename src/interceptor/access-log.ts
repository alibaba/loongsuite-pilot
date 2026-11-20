import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import * as fsp from 'node:fs/promises';
import { loadMaskPlan } from '../mask/rule-loader.js';
import { maskString } from '../mask/string-masker.js';
import { SUPPORTED_INTERCEPTOR_TYPES } from '../types/index.js';
import { interceptorAccessLogPath } from './paths.js';
import type { HookRequest, ManagedRuleMatch } from './types.js';

const accessLogMaskPlan = loadMaskPlan({
  mode: 'custom',
  types: [...SUPPORTED_INTERCEPTOR_TYPES],
  replacementMode: 'placeholder',
});

export const ACCESS_LOG_MAX_CHARS = 256_000;
export const ACCESS_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const ACCESS_LOG_ROTATE_COUNT = 5;

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
  matched?: boolean;
  matches?: ManagedRuleMatch[];
  failOpen?: true;
  reason?: string;
  ruleId?: string;
  ruleVersion?: string;
  severity?: string;
  title?: string;
  message?: string;
  evaluatedRules?: string[];
  error?: string;
}

export interface InterceptorAccessLogEntry {
  ts: string;
  event: string;
  agent?: string;
  sessionId?: string;
  toolUseId?: string;
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
    toolUseId: partial.toolUseId,
    input: partial.input,
    result: partial.result,
  };
}

export function writeInterceptorAccessLog(
  entry: InterceptorAccessLogEntry,
  filePath?: string,
  limits: { maxBytes?: number; rotateCount?: number } = {},
): void {
  try {
    const dest = filePath ?? interceptorAccessLogPath();
    const dir = dirname(dest);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrictAccessLogPermissions(dir);
    rotateAccessLog(dest, limits.maxBytes ?? ACCESS_LOG_MAX_BYTES, limits.rotateCount ?? ACCESS_LOG_ROTATE_COUNT);
    appendFileSync(dest, `${serializeAccessLogEntry(entry)}\n`, 'utf8');
    restrictAccessLogPermissions(dir, dest);
  } catch {
    // Access logs must never affect fail-open or the host verdict.
  }
}

export function rotateAccessLog(filePath: string, maxBytes: number, rotateCount: number): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes || rotateCount < 1) return;
  for (let generation = rotateCount; generation >= 1; generation -= 1) {
    const from = generation === 1 ? filePath : `${filePath}.${generation - 1}`;
    const to = `${filePath}.${generation}`;
    try {
      rmSync(to, { force: true });
      renameSync(from, to);
    } catch {
      // A missing generation is normal; the next write still appends.
    }
  }
}

/** Bounded, ordered audit writer. Neither serialization nor disk IO runs in the HTTP callback. */
export class InterceptorAccessLogWriter {
  private readonly queue: InterceptorAccessLogEntry[] = [];
  private running: Promise<void> | null = null;
  private closed = false;
  private dropped = 0;

  constructor(private readonly file: string, private readonly capacity = 8) {}

  enqueue(entry: InterceptorAccessLogEntry): void {
    if (this.closed) return;
    if (this.queue.length >= this.capacity) {
      this.dropped++;
      return;
    }
    this.queue.push(entry);
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.running;
  }

  private schedule(): void {
    if (this.running) return;
    this.running = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.drain()).finally(() => {
        this.running = null;
        if (this.queue.length || this.dropped) this.schedule();
      });
  }

  private async drain(): Promise<void> {
    while (this.queue.length || this.dropped) {
      const entry = this.queue.shift() ?? buildAccessLogEntry({
        event: 'audit-overflow', input: {},
        result: { action: 'fail-open', error: `audit queue dropped ${this.dropped} records` },
      });
      if (entry.event === 'audit-overflow') this.dropped = 0;
      try {
        const line = `${serializeAccessLogEntry(entry)}\n`;
        const dir = dirname(this.file);
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await fsp.chmod(dir, 0o700).catch(() => {});
        const stat = await fsp.stat(this.file).catch(() => null);
        if (stat && stat.size >= ACCESS_LOG_MAX_BYTES) {
          for (let generation = ACCESS_LOG_ROTATE_COUNT; generation >= 1; generation--) {
            const from = generation === 1 ? this.file : `${this.file}.${generation - 1}`;
            const to = `${this.file}.${generation}`;
            await fsp.rm(to, { force: true }).catch(() => {});
            await fsp.rename(from, to).catch(() => {});
          }
        }
        await fsp.appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') await fsp.chmod(this.file, 0o600).catch(() => {});
      } catch {
        // Audit failures do not affect the verdict; the next entry retries IO.
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

export function serializeAccessLogEntry(entry: InterceptorAccessLogEntry): string {
  const redacted = redactAccessLogEntry(entry);
  const line = safeJson(redacted);
  if (line.length <= ACCESS_LOG_MAX_CHARS) return line;
  return safeJson({
    ...redacted,
    input: truncateInput(redacted.input),
  });
}

function redactAccessLogEntry(entry: InterceptorAccessLogEntry): InterceptorAccessLogEntry {
  return {
    ...entry,
    input: redactUnknown(entry.input) as InterceptorAccessInput,
    result: {
      ...entry.result,
      reason: redactString(entry.result.reason),
      title: redactString(entry.result.title),
      severity: redactString(entry.result.severity),
      message: redactString(entry.result.message),
      error: redactString(entry.result.error),
      ...(entry.result.matches ? { matches: entry.result.matches.map(match => ({
        ...match, reason: redactString(match.reason) ?? '',
        ...(match.title ? { title: redactString(match.title) } : {}),
        ...(match.severity ? { severity: redactString(match.severity) } : {}),
        ...(match.message ? { message: redactString(match.message) } : {}),
      })) } : {}),
    },
  };
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value, accessLogMaskPlan);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactUnknown(child);
    }
    return out;
  }
  return value;
}

function redactString(value: string | undefined): string | undefined {
  if (value == null) return value;
  return maskString(value, accessLogMaskPlan);
}

function restrictAccessLogPermissions(dir: string, filePath?: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A permission failure must not drop the verdict or the log line.
  }
  if (!filePath) return;
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // The file may not exist yet; the post-append call covers the new line.
  }
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
