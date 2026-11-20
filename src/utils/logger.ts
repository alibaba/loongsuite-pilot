import pino from 'pino';
import build from 'pino-roll';
import { writeFile } from 'node:fs/promises';

const LOG_LEVEL = (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as pino.Level;

const pinoOpts: pino.LoggerOptions = {
  level: LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

let rootLogger: pino.Logger = pino(pinoOpts);

// The pino-roll file stream, kept so callers can flush it synchronously before a
// hard process.exit(). pino-roll builds its SonicBoom directly (not via pino's
// buildSafeSonicBoom), so it gets no on-exit flush handler and buffered writes are
// lost on exit unless flushed explicitly.
let fileStreamRef: { flushSync?: () => void } | null = null;

let fileLoggingInitialized = false;
let loggerVersion = 0;
const childCache = new Map<string, { version: number; child: pino.Logger }>();

/**
 * Keep machine-readable CLI stdout free of operational log records. This is
 * intentionally limited to the pre-file-logging phase used by short-lived CLI
 * commands; the collector replaces the root logger in initFileLogging().
 */
export function redirectRootLoggerToStderr(): void {
  if (fileLoggingInitialized) return;
  rootLogger = pino(pinoOpts, process.stderr);
  loggerVersion++;
  childCache.clear();
}

function getChild(tag: string): pino.Logger {
  const cached = childCache.get(tag);
  if (cached && cached.version === loggerVersion) return cached.child;
  const child = rootLogger.child({ tag });
  childCache.set(tag, { version: loggerVersion, child });
  return child;
}

/**
 * Enable file logging with daily rotation via pino-roll.
 * Uses direct in-process streams (no worker threads) so writes are
 * immediate and survive fast process exits.
 */
export async function initFileLogging(logFilePath: string): Promise<void> {
  if (fileLoggingInitialized) return;
  fileLoggingInitialized = true;

  const fileStream = await build({
    file: logFilePath,
    frequency: 'daily',
    mkdir: true,
    size: '50m',
    dateFormat: 'yyyy-MM-dd',
    limit: { count: 10, removeOtherLogFiles: true },
  });
  fileStreamRef = fileStream as unknown as { flushSync?: () => void };

  const useStdout = process.stdout.isTTY || process.env.LOONGSUITE_PILOT_STDOUT === '1';
  const streams: pino.StreamEntry[] = [{ stream: fileStream, level: LOG_LEVEL }];
  if (useStdout) {
    streams.unshift({ stream: process.stdout, level: LOG_LEVEL });
  } else {
    // Daemon mode: truncate the base file that launchd/service manager may
    // have opened via StandardOutPath. pino-roll writes to date-suffixed files
    // so this base file is no longer needed.
    await writeFile(logFilePath, '', 'utf8').catch(() => {});
  }

  rootLogger = pino(pinoOpts, pino.multistream(streams));

  loggerVersion++;
  childCache.clear();
}

/**
 * Synchronously flush buffered file-log writes. Call before a hard process.exit()
 * so the last log lines survive — the pino-roll SonicBoom stream is async and has
 * no on-exit flush of its own. No-op when file logging was never initialized.
 */
export function flushLogsSync(): void {
  try {
    fileStreamRef?.flushSync?.();
  } catch {
    // Best-effort: never let a flush failure block exit.
  }
}

export type BoundLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

export function createLogger(tag: string): BoundLogger {
  return {
    info: (message, meta) => {
      const c = getChild(tag);
      meta ? c.info(meta, message) : c.info(message);
    },
    warn: (message, meta) => {
      const c = getChild(tag);
      meta ? c.warn(meta, message) : c.warn(message);
    },
    error: (message, meta) => {
      const c = getChild(tag);
      meta ? c.error(meta, message) : c.error(message);
    },
    debug: (message, meta) => {
      const c = getChild(tag);
      meta ? c.debug(meta, message) : c.debug(message);
    },
  };
}
