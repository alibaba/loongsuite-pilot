import { Worker } from 'node:worker_threads';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ManagedRegexRunner');

/** A separate Worker keeps RegExp backtracking off the HTTP event loop and can be terminated on timeout. */
export const MANAGED_REGEX_TIMEOUT_MS = 200;

const REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (job) => {
  try {
    const matched = new RegExp(job.pattern).test(job.text);
    parentPort.postMessage({ id: job.id, matched });
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

interface RegexReply {
  id?: number;
  matched?: boolean;
  error?: string;
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

  test(pattern: string, text: string, timeoutMs = this.timeoutMs): Promise<boolean> {
    if (this.stopped) return Promise.reject(new ManagedRegexTimeoutError());
    // Queue and replacement-thread startup time both count against the request.
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const run = this.tail.then(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.stopped) return Promise.reject(new ManagedRegexTimeoutError());
      return this.runOne(pattern, text, remaining);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  stop(): void {
    this.stopped = true;
    this.pending?.reject(new Error('managed regex runner stopped'));
    if (this.worker) this.retire(this.worker);
  }

  private runOne(pattern: string, text: string, timeoutMs: number): Promise<boolean> {
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
