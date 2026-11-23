import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { isUpdaterRunningOnWindowsSync } from '../../../src/utils/process-discovery.js';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('isUpdaterRunningOnWindowsSync', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  it('returns false and does not invoke powershell on non-win32', () => {
    setPlatform('darwin');
    expect(isUpdaterRunningOnWindowsSync()).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    setPlatform(originalPlatform);
  });

  it('returns true when powershell output contains a matching updater command line', () => {
    setPlatform('win32');
    mockedExecFileSync.mockReturnValueOnce('12345\tnode C:\\Users\\test\\.loongsuite-pilot\\bin\\updater-daemon.js\r\n' as unknown as Buffer);
    expect(isUpdaterRunningOnWindowsSync()).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-WindowStyle', 'Hidden', '-Command']),
      expect.objectContaining({ timeout: 8000, encoding: 'utf-8', windowsHide: true }),
    );
    setPlatform(originalPlatform);
  });

  it('returns false when powershell output has no matching updater command', () => {
    setPlatform('win32');
    mockedExecFileSync.mockReturnValueOnce('12345\tnode unrelated.js\r\n' as unknown as Buffer);
    expect(isUpdaterRunningOnWindowsSync()).toBe(false);
    setPlatform(originalPlatform);
  });

  it('returns false when powershell output is empty', () => {
    setPlatform('win32');
    mockedExecFileSync.mockReturnValueOnce('' as unknown as Buffer);
    expect(isUpdaterRunningOnWindowsSync()).toBe(false);
    setPlatform(originalPlatform);
  });

  it('returns false when powershell throws', () => {
    setPlatform('win32');
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error('powershell missing');
    });
    expect(isUpdaterRunningOnWindowsSync()).toBe(false);
    setPlatform(originalPlatform);
  });
});
