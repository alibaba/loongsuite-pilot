const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type LogMethodLevel = keyof typeof LEVELS;

function getThreshold(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVELS) {
    return LEVELS[raw as LogMethodLevel];
  }
  return LEVELS.info;
}

function shouldLog(methodLevel: LogMethodLevel): boolean {
  return LEVELS[methodLevel] >= getThreshold();
}

function formatLine(
  level: string,
  tag: string,
  message: string,
  meta?: Record<string, unknown>
): string {
  const time = new Date().toISOString();
  const metaStr =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${time}] [${level}] [${tag}] ${message}${metaStr}`;
}

/**
 * Simple structured logger with `LOG_LEVEL` filtering (debug / info / warn / error, default info).
 */
export class Logger {
  static info(
    tag: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!shouldLog('info')) return;
    console.log(formatLine('INFO', tag, message, meta));
  }

  static warn(
    tag: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!shouldLog('warn')) return;
    console.warn(formatLine('WARN', tag, message, meta));
  }

  static error(
    tag: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!shouldLog('error')) return;
    console.error(formatLine('ERROR', tag, message, meta));
  }

  static debug(
    tag: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!shouldLog('debug')) return;
    console.log(formatLine('DEBUG', tag, message, meta));
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
    info: (message, meta) => Logger.info(tag, message, meta),
    warn: (message, meta) => Logger.warn(tag, message, meta),
    error: (message, meta) => Logger.error(tag, message, meta),
    debug: (message, meta) => Logger.debug(tag, message, meta),
  };
}
