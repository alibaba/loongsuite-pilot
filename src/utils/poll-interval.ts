/**
 * One poll interval for every agent collector.
 * Milliseconds. Non-numeric, empty, and non-positive values are ignored.
 */
export const POLL_INTERVAL_ENV = 'LOONGSUITE_PILOT_POLL_INTERVAL_MS';

/** Built-in collector poll interval when no env var or listener override is set. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Parsed unified poll interval, or undefined when the env var is unset or invalid. */
export function globalPollIntervalMs(): number | undefined {
  const raw = process.env[POLL_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Env wins over a per-listener or per-input value. `configured` is kept as-is
 * when the env var is unset, including 0, so existing callers do not change.
 */
export function resolvePollIntervalMs(configured: number | undefined, fallback: number): number {
  return globalPollIntervalMs() ?? configured ?? fallback;
}
