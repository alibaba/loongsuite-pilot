/** Upload transport defaults (not user-facing config). */
export const MULTIMODAL_UPLOAD_MAX_ATTEMPTS = 3;
export const MULTIMODAL_UPLOAD_BASE_DELAY_MS = 200;
export const MULTIMODAL_UPLOAD_TIMEOUT_MS = 30_000;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export const DEFAULT_MULTIMODAL_RETRY: RetryPolicy = {
  maxAttempts: MULTIMODAL_UPLOAD_MAX_ATTEMPTS,
  baseDelayMs: MULTIMODAL_UPLOAD_BASE_DELAY_MS,
};

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff. Attempt is 1-based. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const exp = Math.min(policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)), 10_000);
  return Math.floor(Math.random() * Math.max(1, exp));
}

export async function withRetries<T>(
  policy: RetryPolicy,
  run: (attempt: number) => Promise<{ ok: true; value: T } | { ok: false; retryable: boolean; error?: string; statusCode?: number }>,
): Promise<{ ok: true; value: T } | { ok: false; error?: string; statusCode?: number }> {
  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const result = await run(attempt);
    if (result.ok) return result;
    lastError = result.error;
    lastStatus = result.statusCode;
    if (!result.retryable || attempt >= policy.maxAttempts) {
      return { ok: false, error: lastError, statusCode: lastStatus };
    }
    await sleep(retryDelayMs(policy, attempt));
  }

  return { ok: false, error: lastError, statusCode: lastStatus };
}
