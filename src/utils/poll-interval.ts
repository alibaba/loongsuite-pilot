/**
 * One poll interval for every agent collector.
 * Milliseconds. Only decimal integers from 1000 through 2147483647 are
 * accepted. Fractions, scientific notation, hex, and out-of-range values are
 * ignored so Node cannot clamp setInterval back to a 1ms timer.
 */
export const POLL_INTERVAL_ENV = 'LOONGSUITE_PILOT_POLL_INTERVAL_MS';

/** Built-in collector poll interval when no env var or listener override is set. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Shortest accepted unified interval. Below this, Node's timer clamp is too easy to hit. */
const MIN_POLL_INTERVAL_MS = 1_000;

/** Largest delay setInterval accepts before clamping to 1ms. */
const MAX_POLL_INTERVAL_MS = 2_147_483_647;

/** Parsed unified poll interval, or undefined when the env var is unset or invalid. */
export function globalPollIntervalMs(): number | undefined {
  const raw = process.env[POLL_INTERVAL_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < MIN_POLL_INTERVAL_MS || n > MAX_POLL_INTERVAL_MS) return undefined;
  return n;
}

/**
 * Env wins over a per-listener or per-input value. `configured` is kept as-is
 * when the env var is unset, including 0, so existing callers do not change.
 */
export function resolvePollIntervalMs(configured: number | undefined, fallback: number): number {
  return globalPollIntervalMs() ?? configured ?? fallback;
}
