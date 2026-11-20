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
  let configPath: string;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(async () => {
    dataDir = await createTempDir('menubar-cli-');
    configPath = path.join(dataDir, 'config.json');
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', configPath);
    vi.stubEnv('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', '');
    await fs.writeFile(configPath, JSON.stringify({ keepMe: 'unchanged', enableStatusBarApp: true }, null, 2));
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-start enabled'));
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

  it('persists enablement and starts when config.json was disabled', async () => {
    await fs.writeFile(configPath, JSON.stringify({ keepMe: 'unchanged', enableStatusBarApp: false }, null, 2));
    vi.mocked(loadConfig).mockResolvedValue({ dataDir, statusBar: { enabled: false } } as never);

    expect(await runMenubarCommand(['start'])).toBe(0);
    expect(StatusBarAppManager.prototype.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
      keepMe: 'unchanged',
      enableStatusBarApp: true,
    });
  });

  it.each(['false', '0'])('does not override a disabling environment value: %s', async value => {
    vi.stubEnv('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', value);
    await fs.writeFile(configPath, JSON.stringify({ enableStatusBarApp: false }, null, 2));

    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('disabled by LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP'));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({ enableStatusBarApp: false });
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

  it('keeps persisted enablement when the collector is unavailable', async () => {
    await fs.writeFile(configPath, JSON.stringify({ enableStatusBarApp: false }, null, 2));
    await fs.rm(path.join(dataDir, 'logs', 'runtime.json'));

    expect(await runMenubarCommand(['start'])).toBe(1);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).enableStatusBarApp).toBe(true);
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
    await fs.chmod(configPath, 0o640);

    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(StatusBarAppManager.prototype.stop).toHaveBeenCalledWith('cli-request');
    expect(StatusBarAppManager.prototype.start).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('stopped (PID 12345)'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-start disabled'));
    expect(await fs.readFile(runtimePath, 'utf8')).toBe(before);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
      keepMe: 'unchanged',
      enableStatusBarApp: false,
    });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o640);
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

  it('creates a private config file when config.json is missing', async () => {
    await fs.rm(configPath);

    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({ enableStatusBarApp: false });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['{invalid', 'invalid JSON config'],
    ['[]', 'non-object JSON config'],
  ])('refuses to overwrite unsupported config.json content: %s', async (content, errorText) => {
    await fs.writeFile(configPath, content);

    expect(await runMenubarCommand(['stop'])).toBe(1);
    expect(await fs.readFile(configPath, 'utf8')).toBe(content);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(StatusBarAppManager.prototype.stop).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`refusing to overwrite ${errorText}`));
  });

  it('warns when an enabling environment value overrides persisted disablement', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', 'true');

    expect(await runMenubarCommand(['stop'])).toBe(0);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).enableStatusBarApp).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('overrides config.json'));
  });

  it('does not report success when stopping fails', async () => {
    vi.mocked(StatusBarAppManager.prototype.stop).mockRejectedValue(new Error('Menu bar app did not stop'));
    expect(await runMenubarCommand(['stop'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('did not stop'));
    expect(console.log).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).enableStatusBarApp).toBe(false);
  });
});
