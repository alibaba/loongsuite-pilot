import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(resolve('scripts/manage-dashboard-shortcut.js'), 'utf8');
const { manageShortcut } = runInNewContext(script + '\n({ manageShortcut })');
let system;
let request;
let files;
let dockPaths;
let shortcutPath;
beforeEach(() => {
  files = new Map();
  dockPaths = ['/Users/test/Downloads'];
  shortcutPath = '/Users/test/Library/Application Support/LoongSuite Pilot/Shortcuts/LoongSuite Pilot Dashboard.webloc';
  request = { action: 'install', configPath: "/Users/test/配置 ' $() ;/config.json", url: 'http://127.0.0.1:9000/',
    iconVersion: 'a'.repeat(64), iconPath: '/package/icon.icns', operationId: '00000000-0000-4000-8000-000000000001' };
  system = {
    homePath: '/Users/test', userName: 'test',
    checkParents: vi.fn(),
    readShortcut: vi.fn(path => files.get(path) || { kind: 'absent' }),
    readDock: vi.fn(() => ({ paths: [...dockPaths], locked: false })),
    withLock: vi.fn((_base, _owner, fn) => fn()),
    validateIcon: vi.fn(),
    writeShortcut: vi.fn((path, value) => files.set(path, { kind: 'file', value })),
    setIcon: vi.fn(() => true),
    changeDock: vi.fn((_before, action, path) => {
      dockPaths = action === 'add' ? [...dockPaths, path] : dockPaths.filter(item => item !== path);
      return '/backup/dock.plist';
    }),
    trashShortcut: vi.fn(path => files.delete(path)),
    refreshDock: vi.fn(() => true),
  };
});

describe('explicit macOS shortcut policy', () => {
  it('creates a config-bound webloc and adds exactly one Dock entry', () => {
    const result = manageShortcut(request, system);
    expect(result).toMatchObject({ exists: true, managed: true, changed: true, iconApplied: true, dockMatches: 1, url: request.url });
    expect(files.get(shortcutPath).value).toMatchObject({ URL: request.url, PilotConfigPath: request.configPath });
    expect(dockPaths).toEqual(['/Users/test/Downloads', shortcutPath]);
    expect(system.refreshDock).toHaveBeenCalledTimes(1);
  });
  it('is idempotent, keeps position, and updates changed ports/icons in place', () => {
    manageShortcut(request, system);
    dockPaths.push('/Users/test/another-file');
    expect(manageShortcut(request, system).changed).toBe(false);
    expect(system.changeDock).toHaveBeenCalledTimes(1);
    expect(system.refreshDock).toHaveBeenCalledTimes(1);
    expect(manageShortcut({ ...request, url: 'http://127.0.0.1:9010/', iconVersion: 'b'.repeat(64) }, system).changed).toBe(true);
    expect(files.get(shortcutPath).value.URL).toBe('http://127.0.0.1:9010/');
    expect(dockPaths).toEqual(['/Users/test/Downloads', shortcutPath, '/Users/test/another-file']);
    expect(system.changeDock).toHaveBeenCalledTimes(1);
  });
  it('status shows the stored URL and never writes, even for a locked Dock', () => {
    manageShortcut(request, system);
    vi.clearAllMocks();
    system.readDock.mockImplementation(() => ({ paths: [...dockPaths], locked: true }));
    expect(manageShortcut({ ...request, action: 'status', url: 'http://127.0.0.1:9999/' }, system)).toMatchObject({ url: request.url, dockLocked: true });
    for (const method of ['withLock', 'writeShortcut', 'setIcon', 'changeDock', 'trashShortcut', 'refreshDock']) expect(system[method]).not.toHaveBeenCalled();
  });
  it('status on an absent shortcut creates no directories', () => {
    expect(manageShortcut({ ...request, action: 'status' }, system)).toMatchObject({ exists: false, url: null, dockMatches: 0 });
    expect(system.withLock).not.toHaveBeenCalled();
  });
  it('removes only the matching managed file and Dock item; repeat uninstall is a no-op', () => {
    manageShortcut(request, system);
    files.set('/Users/test/keep', { kind: 'file', value: 'keep' });
    dockPaths.push('/Users/test/keep');
    const result = manageShortcut({ ...request, action: 'uninstall' }, system);
    expect(result).toMatchObject({ exists: false, url: null, dockMatches: 0, changed: true });
    expect(system.trashShortcut).toHaveBeenCalledWith(shortcutPath);
    expect(files.has('/Users/test/keep')).toBe(true);
    expect(dockPaths).toEqual(['/Users/test/Downloads', '/Users/test/keep']);
    expect(manageShortcut({ ...request, action: 'uninstall' }, system).changed).toBe(false);
  });
  it.each([{ kind: 'other' }, { kind: 'directory' }, { kind: 'file', value: null }, { kind: 'file', value: { URL: 'https://example.test/' } }])('preserves unmanaged/invalid files %j', file => {
    files.set(shortcutPath, file);
    for (const action of ['install', 'uninstall']) expect(() => manageShortcut({ ...request, action }, system)).toThrow('unmanaged');
    expect(system.writeShortcut).not.toHaveBeenCalled();
    expect(system.trashShortcut).not.toHaveBeenCalled();
  });
  it('preserves another configuration and does not expose its URL in status', () => {
    manageShortcut(request, system);
    const other = { ...request, configPath: '/Users/test/other/config.json' };
    for (const action of ['install', 'uninstall']) expect(() => manageShortcut({ ...other, action }, system)).toThrow('another configuration');
    expect(manageShortcut({ ...other, action: 'status' }, system)).toMatchObject({ managed: false, url: null });
  });
  it('reports missing files without deleting unowned orphaned Dock entries', () => {
    dockPaths.push(shortcutPath);
    expect(manageShortcut({ ...request, action: 'status' }, system)).toMatchObject({ exists: false, dockMatches: 1 });
    expect(() => manageShortcut({ ...request, action: 'uninstall' }, system)).toThrow('orphaned');
    expect(system.changeDock).not.toHaveBeenCalled();
  });
  it('refuses duplicate, locked, or concurrently replaced state', () => {
    dockPaths.push(shortcutPath, shortcutPath);
    expect(() => manageShortcut(request, system)).toThrow('Multiple');
    dockPaths = [];
    system.readDock.mockReturnValue({ paths: [], locked: true });
    expect(() => manageShortcut(request, system)).toThrow('locked');
    system.readDock.mockReturnValue({ paths: [], locked: false });
    system.readShortcut.mockReturnValueOnce({ kind: 'absent' }).mockReturnValue({ kind: 'other' });
    expect(() => manageShortcut(request, system)).toThrow('ownership changed');
    expect(system.writeShortcut).not.toHaveBeenCalled();
  });
  it('validates the icon before replacing a shortcut', () => {
    manageShortcut(request, system);
    system.validateIcon.mockImplementation(() => { throw new Error('missing icon'); });
    expect(() => manageShortcut({ ...request, url: 'http://127.0.0.1:9001/' }, system)).toThrow('missing icon');
    expect(files.get(shortcutPath).value.URL).toBe(request.url);
  });
  it('reports icon and Dock refresh failures and retries icon application', () => {
    system.setIcon.mockReturnValue(false);
    system.refreshDock.mockReturnValue(false);
    expect(manageShortcut(request, system).warnings).toHaveLength(2);
    system.setIcon.mockReturnValue(true);
    expect(manageShortcut(request, system)).toMatchObject({ iconApplied: true, changed: true });
  });
  it.each(['https://example.test/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://localhost:9000/', 'http://127.0.0.1:9000/;bad'])('rejects unsafe URL %s', url => {
    expect(() => manageShortcut({ ...request, url }, system)).toThrow('local Dashboard URL');
    expect(system.writeShortcut).not.toHaveBeenCalled();
  });
  it('rejects root, relative config paths and unknown commands', () => {
    expect(() => manageShortcut(request, { ...system, userName: 'root' })).toThrow('without sudo');
    expect(() => manageShortcut({ ...request, configPath: 'config.json' }, system)).toThrow('absolute');
    expect(() => manageShortcut({ ...request, action: 'repair' }, system)).toThrow('Unknown');
  });
});
