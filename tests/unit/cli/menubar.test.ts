import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { loadConfig } from '../../../src/core/config-loader.js';
import { StatusBarAppManager } from '../../../src/status-bar/status-bar-app-manager.js';
import { isProcessAlive } from '../../../src/utils/pid-utils.js';
import { runMenubarCommand } from '../../../src/cli/menubar.js';

vi.mock('../../../src/core/config-loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../../src/utils/pid-utils.js', () => ({ isProcessAlive: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('menubar CLI', () => {
  let dataDir: string;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(async () => {
    dataDir = await createTempDir('menubar-cli-');
    await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'logs', 'runtime.json'), JSON.stringify({
      status: 'active', pid: 6789, packageVersion: '1.0.0',
    }));
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(loadConfig).mockReset().mockResolvedValue({ dataDir, statusBar: { enabled: true } } as never);
    vi.mocked(isProcessAlive).mockReset().mockReturnValue(true);
    vi.spyOn(StatusBarAppManager.prototype, 'start').mockResolvedValue({ status: 'started', pid: 12345 });
    vi.spyOn(StatusBarAppManager.prototype, 'stop').mockResolvedValue({ status: 'stopped', pids: [12345] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
    await cleanupTempDir(dataDir);
  });

  it.each([[], ['--help'], ['start', '--help'], ['stop', '--help']])('shows help without changing anything: %j', async (...args) => {
    expect(await runMenubarCommand(args)).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.stop).not.toHaveBeenCalled();
  });

  it.each([['restart'], ['start', 'unexpected'], ['stop', 'unexpected']])('rejects unsupported arguments: %j', async (...args) => {
    expect(await runMenubarCommand(args)).toBe(1);
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.stop).not.toHaveBeenCalled();
  });

  it('starts only the menu bar and preserves collector runtime state', async () => {
    const runtimePath = path.join(dataDir, 'logs', 'runtime.json');
    const before = await fs.readFile(runtimePath, 'utf8');
    expect(await runMenubarCommand(['start'])).toBe(0);
    expect(StatusBarAppManager.prototype.start).toHaveBeenCalledTimes(1);
    expect(isProcessAlive).toHaveBeenCalledWith(6789);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('started (PID 12345)'));
    expect(await fs.readFile(runtimePath, 'utf8')).toBe(before);
  });

  it('reports an already running app', async () => {
    vi.mocked(StatusBarAppManager.prototype.start).mockResolvedValue({ status: 'already-running', pid: 12345 });
    expect(await runMenubarCommand(['start'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it.each(['start', 'stop'])('rejects %s on non-macOS platforms', async command => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(await runMenubarCommand([command])).toBe(1);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.stop).not.toHaveBeenCalled();
  });

  it('respects the disabled menu bar setting', async () => {
    vi.mocked(loadConfig).mockResolvedValue({ dataDir, statusBar: { enabled: false } } as never);
    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'stopped', 'dead', 'bad-pid'])('rejects unavailable collector runtime: %s', async scenario => {
    const runtimePath = path.join(dataDir, 'logs', 'runtime.json');
    if (scenario === 'missing') await fs.rm(runtimePath);
    if (scenario === 'invalid') await fs.writeFile(runtimePath, '{invalid');
    if (scenario === 'stopped') await fs.writeFile(runtimePath, JSON.stringify({ status: 'stopped', pid: 6789 }));
    if (scenario === 'bad-pid') await fs.writeFile(runtimePath, JSON.stringify({ status: 'active', pid: -1 }));
    if (scenario === 'dead') vi.mocked(isProcessAlive).mockReturnValue(false);

    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('loongsuite-pilot start'));
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
  });

  it('returns failure if no app could be started', async () => {
    vi.mocked(StatusBarAppManager.prototype.start).mockResolvedValue(null);
    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
  });

  it('returns launch errors without reporting success', async () => {
    vi.mocked(StatusBarAppManager.prototype.start).mockRejectedValue(new Error('spawn EACCES'));
    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    expect(console.log).not.toHaveBeenCalled();
  });

  it('stops only the menu bar and leaves collector runtime unchanged', async () => {
    const runtimePath = path.join(dataDir, 'logs', 'runtime.json');
    const before = await fs.readFile(runtimePath, 'utf8');

    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(StatusBarAppManager.prototype.stop).toHaveBeenCalledWith('cli-request');
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('stopped (PID 12345)'));
    expect(await fs.readFile(runtimePath, 'utf8')).toBe(before);
  });

  it('can stop a leftover app when disabled and no collector runtime exists', async () => {
    await fs.rm(path.join(dataDir, 'logs', 'runtime.json'));
    vi.mocked(loadConfig).mockResolvedValue({ dataDir, statusBar: { enabled: false } } as never);

    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(StatusBarAppManager.prototype.stop).toHaveBeenCalledWith('cli-request');
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
  });

  it('succeeds when the menu bar is already stopped', async () => {
    vi.mocked(StatusBarAppManager.prototype.stop).mockResolvedValue({ status: 'already-stopped', pids: [] });
    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already stopped'));
  });

  it('does not report success when stopping fails', async () => {
    vi.mocked(StatusBarAppManager.prototype.stop).mockRejectedValue(new Error('Menu bar app did not stop'));
    expect(await runMenubarCommand(['stop'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('did not stop'));
    expect(console.log).not.toHaveBeenCalled();
  });
});
