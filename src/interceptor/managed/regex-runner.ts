import { Worker } from 'node:worker_threads';
import { createLogger } from '../../utils/logger.js';
import type { SubstringMatchPlan } from './config.js';

const logger = createLogger('ManagedRegexRunner');

/** A separate Worker keeps RegExp backtracking off the HTTP event loop and can be terminated on timeout. */
export const MANAGED_REGEX_TIMEOUT_MS = 200;
export const MANAGED_REGEX_SLOW_MS = 50;

export const REGEX_CACHE_MAX_ENTRIES = 128;
export const REGEX_CACHE_MAX_SOURCE_CHARS = 1024 * 1024;

export const REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const cache = new Map();
let sourceChars = 0;
function compiled(pattern) {
  let regex = cache.get(pattern);
  if (regex) {
    cache.delete(pattern);
    cache.set(pattern, regex);
    return regex;
  }
  regex = new RegExp(pattern);
  if (pattern.length > ${REGEX_CACHE_MAX_SOURCE_CHARS}) return regex;
  while (cache.size >= ${REGEX_CACHE_MAX_ENTRIES} || sourceChars + pattern.length > ${REGEX_CACHE_MAX_SOURCE_CHARS}) {
    const oldest = cache.keys().next().value;
    sourceChars -= oldest.length;
    cache.delete(oldest);
  }
  cache.set(pattern, regex);
  sourceChars += pattern.length;
  return regex;
}
function matches(pattern, text) {
  if (typeof pattern === 'string') return compiled(pattern).test(text);
  // The whole plan is one job: every step shares the caller's one timer.
  for (const step of pattern.steps) {
    if (step.kind === 'literal' ? text.includes(step.text) : compiled(step.source).test(text)) return true;
  }
  return false;
}
parentPort.on('message', (job) => {
  try {
    const started = performance.now();
    const matched = matches(job.pattern, job.text);
    parentPort.postMessage({ id: job.id, matched, executionMs: performance.now() - started });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  }
});
`;

export class ManagedRegexTimeoutError extends Error {
  constructor() {
    super('managed regex timed out');
    this.name = 'ManagedRegexTimeoutError';
  }
}

/** Normal shutdown cancels matching work without reporting a worker fault. */
export class ManagedRegexCancelledError extends Error {
  constructor() {
    super('managed regex runner stopped');
    this.name = 'ManagedRegexCancelledError';
  }
}

interface RegexReply {
  id?: number;
  matched?: boolean;
  error?: string;
  executionMs?: number;
}

/** One reused matching thread, owned and timed by the interceptor Worker. */
export class ManagedRegexRunner {
  private worker: Worker | null = null;
  private pending: { worker: Worker | null; reject: (error: Error) => void } | null = null;
  private retiring: Promise<void> = Promise.resolve();
  private seq = 0;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly timeoutMs = MANAGED_REGEX_TIMEOUT_MS) {}

  test(pattern: string | SubstringMatchPlan, text: string, timeoutMs = this.timeoutMs, onExecuted?: (executionMs: number) => void): Promise<boolean> {
    if (this.stopped) return Promise.reject(new ManagedRegexCancelledError());
    // Queue and replacement-thread startup time both count against the request.
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const run = this.tail.then(() => {
      if (this.stopped) return Promise.reject(new ManagedRegexCancelledError());
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new ManagedRegexTimeoutError());
      return this.runOne(pattern, text, remaining, onExecuted);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  stop(): void {
    this.stopped = true;
    this.pending?.reject(new ManagedRegexCancelledError());
    if (this.worker) this.retire(this.worker);
  }

  private runOne(pattern: string | SubstringMatchPlan, text: string, timeoutMs: number, onExecuted?: (executionMs: number) => void): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let worker: Worker | null = null;
      let settled = false;
      const id = ++this.seq;
      const finish = (error?: Error, matched?: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker?.off('message', onMessage);
        if (this.pending === pending) this.pending = null;
        if (error) reject(error); else resolve(matched === true);
      };
      const onMessage = (reply: RegexReply) => {
        if (reply.id !== id) return;
        if (typeof reply.executionMs === 'number') {
          try { onExecuted?.(reply.executionMs); } catch { /* Monitoring cannot change a match. */ }
        }
        finish(reply.error ? new Error(reply.error) : undefined, reply.matched);
      };
      const timer = setTimeout(() => {
        finish(new ManagedRegexTimeoutError());
        if (worker) this.retire(worker);
      }, Math.max(1, timeoutMs));

      const pending = { worker: null as Worker | null, reject: (error: Error) => finish(error) };
      this.pending = pending;
      void this.ensure(() => settled).then(current => {
        if (!current || settled) return;
        worker = current;
        pending.worker = worker;
        worker.on('message', onMessage);
        // Adding a message listener refs the port, so unref only afterwards.
        worker.unref();
        try { worker.postMessage({ id, pattern, text }); }
        catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          this.retire(worker);
        }
      }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async ensure(cancelled: () => boolean): Promise<Worker | null> {
    // Await exit before creating a replacement, even when the previous request
    // has already failed open. Repeated timeouts cannot accumulate threads.
    await this.retiring;
    if (cancelled() || this.stopped) return null;
    if (this.worker) return this.worker;
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('error', error => {
      if (this.pending?.worker === worker) this.pending.reject(error);
      this.retire(worker);
    });
    worker.on('exit', code => {
      if (this.worker === worker) this.worker = null;
      if (this.pending?.worker === worker) {
        this.pending.reject(new Error(`managed regex worker exited with ${code}`));
      }
    });
    this.worker = worker;
    worker.unref();
    return worker;
  }

  private retire(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.retiring = worker.terminate().then(() => undefined);
    // A failed termination must not permit a second matching thread to start.
    void this.retiring.catch(error => {
      logger.warn('managed regex worker termination failed; matching will fail open until interceptor restart', {
        error: String(error),
      });
    });
  }
}
