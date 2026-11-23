export function sendAlarm(_topic: string, _data: Record<string, unknown>): void {}
export function sendStatus(_topic: string, _data: Record<string, unknown>): void {}

/**
 * Awaitable alarm send used by `hook install`. The open-source build has
 * nowhere to deliver it and reports that immediately. The proprietary build
 * aliases this module to the internal sender at bundle time.
 */
export async function postAlarm(
  _topic: string,
  _data: Record<string, unknown>,
  _timeoutMs: number,
): Promise<boolean> {
  return false;
}
