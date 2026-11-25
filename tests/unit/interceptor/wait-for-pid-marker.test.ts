import { afterEach, expect, it, vi } from 'vitest';
import { waitForPidMarker } from '../../helpers/wait-for-pid-marker.js';

afterEach(() => vi.useRealTimers());

it('waits through creation, sharing violations and an empty file before accepting the PID', async () => {
  vi.useFakeTimers();
  const read = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('not created'), { code: 'ENOENT' }))
    .mockRejectedValueOnce(Object.assign(new Error('writer holds file'), { code: 'EBUSY' }))
    .mockResolvedValueOnce('\uFEFF\r\n')
    .mockResolvedValueOnce('\uFEFF12345\r\n');
  const result = waitForPidMarker('descendant.pid', undefined, { read });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe(12345);
  expect(read).toHaveBeenCalledTimes(4);
});

it.each(['', '0', '-1', 'NaN', '123garbage', '9007199254740992'])('does not treat %j as a ready PID', async text => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValueOnce(text).mockResolvedValue('42');
  const result = waitForPidMarker('descendant.pid', undefined, { read });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe(42);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['ENOENT', 'EBUSY'])('fails within its deadline with diagnostics if %s persists', async code => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), { code }));
  const result = waitForPidMarker('descendant.pid', () => 'guardian stderr', { read, timeoutMs: 30 });
  const assertion = expect(result).rejects.toThrow(`Timed out waiting for native PID marker descendant.pid (${code}); guardian stderr`);
  await vi.runAllTimersAsync();
  await assertion;
  expect(read).toHaveBeenCalledTimes(4);
});

it('does not hide unrelated filesystem errors', async () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const read = vi.fn().mockRejectedValue(error);
  await expect(waitForPidMarker('descendant.pid', undefined, { read })).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
});
