export const ZCODE_MODEL_CANCELLED = 'zcode.model_cancelled';
export const ZCODE_MODEL_ERROR = 'zcode.model_error';

type ZCodeRolloutFailure =
  | { finishReason: 'cancelled'; errorType: typeof ZCODE_MODEL_CANCELLED }
  | { finishReason: 'error'; errorType: typeof ZCODE_MODEL_ERROR };

export function classifyZCodeRolloutFailure(
  finishReason: string | undefined,
  rawError: unknown,
): ZCodeRolloutFailure | undefined {
  const reason = finishReason?.trim().toLowerCase();
  const error = rawError && typeof rawError === 'object' && !Array.isArray(rawError)
    ? rawError as Record<string, unknown>
    : undefined;
  const message = typeof rawError === 'string' ? rawError : error?.message;
  if (reason === 'cancelled' || reason === 'canceled' || reason === 'interrupted' || reason === 'aborted' ||
      error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
      message === 'CLI received SIGINT' || message === 'CLI received SIGTERM') {
    return { finishReason: 'cancelled', errorType: ZCODE_MODEL_CANCELLED };
  }
  if (reason === 'error' || error || (typeof message === 'string' && message.trim())) {
    return { finishReason: 'error', errorType: ZCODE_MODEL_ERROR };
  }
  return undefined;
}
