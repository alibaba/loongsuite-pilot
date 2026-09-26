import { describe, expect, it, vi } from 'vitest';
import {
  classifyExecutable,
  readWindowsProcess,
  resolveQoderSurface,
} from '../../../src/interceptor/cli/qoder-surface.js';

describe('qoder surface detection', () => {
  it('classifies desktop and CLI executables', () => {
    expect(classifyExecutable('/usr/bin/qoder')).toBe('qoder');
    expect(classifyExecutable('Qoder.exe')).toBe('qoder');
    expect(classifyExecutable('qodercli')).toBe('qodercli');
    expect(classifyExecutable('qoder-cli')).toBe('qodercli');
  });

  it('ignores Qoder Work and interceptor hosts', () => {
    expect(classifyExecutable('qoderwork')).toBeNull();
    expect(classifyExecutable('QwenWorkCN')).toBeNull();
    expect(classifyExecutable('qwenworkcn.exe')).toBeNull();
    expect(classifyExecutable('node')).toBeNull();
    expect(classifyExecutable('interceptor-cli')).toBeNull();
  });

  it('prefers QODER_CONFIG_DIR when it points at the desktop profile', () => {
    expect(resolveQoderSurface({ QODER_CONFIG_DIR: '/home/u/.qoder' })).toBe('qoder');
  });

  it('uses PowerShell CIM rather than the removed WMIC executable on Windows', () => {
    const exec = vi.fn(() => 'qodercli.exe\r\n123\r\n');

    expect(readWindowsProcess(456, exec)).toEqual({
      name: 'qodercli.exe',
      ppid: 123,
    });
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NonInteractive', '-Command']),
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
