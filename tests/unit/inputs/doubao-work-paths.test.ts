import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });
type NativeRoots = { userDataRoot?: string; sessionsRoot?: string; snapshotRoot?: string };
const roots = (input: DoubaoWorkInput) => input as unknown as NativeRoots;
const stateStore = () => new StateStore(path.join(tmpdir(), 'doubao-path-test-unused-state.json'));

describe.each(['darwin', 'win32'] as const)('Doubao native roots on %s', target => {
  it('keeps native roots under the platform data directory for shallow, relative and Unicode log overrides', () => {
    Object.defineProperty(process, 'platform', { value: target });
    vi.stubEnv('LOCALAPPDATA', 'D:\\Synthetic Local');
    const paths = target === 'win32' ? path.win32 : path.posix;
    const data = target === 'win32' ? 'D:\\Synthetic Local\\DoubaoWork\\User Data'
      : paths.join(homedir(), 'Library', 'Application Support', 'DoubaoWork');
    for (const logDir of ['/logs', '/tmp/doubao-logs', '../logs', 'relative 中文']) {
      const input = new DoubaoWorkInput({ stateStore: stateStore(), logDir });
      expect(roots(input).userDataRoot).toBe(data);
      expect(roots(input).snapshotRoot).toBe(paths.join(data, 'coding', 'snapshot'));
    }
    expect(DoubaoWorkInput.defaultLogDir()).toBe(paths.join(data, 'sdk_storage', 'log'));
  });

  it('preserves separately supplied session and snapshot roots', () => {
    Object.defineProperty(process, 'platform', { value: target });
    const sessionsRoot = path.join(tmpdir(), 'isolated-sessions'), snapshotRoot = path.join(tmpdir(), 'isolated-snapshots');
    const input = new DoubaoWorkInput({ stateStore: stateStore(), logDir: '/logs', sessionsRoot, snapshotRoot });
    expect(roots(input).sessionsRoot).toBe(sessionsRoot);
    expect(roots(input).snapshotRoot).toBe(snapshotRoot);
  });
});

it('does not infer native roots from a log override on an unsupported platform', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const input = new DoubaoWorkInput({ stateStore: stateStore(), logDir: '/logs' });
  expect(roots(input).userDataRoot).toBeUndefined();
  expect(roots(input).snapshotRoot).toBeUndefined();
});
