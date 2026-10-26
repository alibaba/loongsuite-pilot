import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../helpers/doubao-work-fixture.js';

const windowsFile = DOUBAO_FILE.replace('saman_frontend_', 'saman_');
const windowsLine = (event: string, elapsedMs: number) => doubaoLine(event, {}, elapsedMs)
  .replace(/(\.\d{3})\d{3}:(INFO|WARNING|ERROR):FRONTEND\(0\)/, '$1:$2:CONSOLE(0)');
class ProbeInput extends DoubaoWorkInput { poll() { return this.collect(); } }
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Doubao Work Windows 2.25 client logs', () => {
  it('reads native CONSOLE millisecond boundaries and keeps macOS microseconds', () => {
    const windows = parseDoubaoLogLine(windowsLine('on_message_session_end', 1234).trimEnd(), windowsFile);
    expect(windows?.timeNano).toBe((BigInt(DOUBAO_EPOCH + 1234) * 1_000_000n).toString());
    expect(windows?.clientOutcome).toBe('received');
    const mac = parseDoubaoLogLine(doubaoLine('on_message_session_end', {}, 1234).trimEnd(), DOUBAO_FILE);
    expect(mac?.timeNano).toBe((BigInt(DOUBAO_EPOCH + 1234) * 1_000_000n + 123_000n).toString());
  });

  it('rejects unrelated files and mismatched producer headers or precision', () => {
    const win = windowsLine('on_message_session_end', 1234).trimEnd();
    const mac = doubaoLine('on_message_session_end', {}, 1234).trimEnd();
    expect(parseDoubaoLogLine(win, windowsFile.replace('saman_', 'saman_repair_'))).toBeUndefined();
    expect(parseDoubaoLogLine(win, DOUBAO_FILE)).toBeUndefined();
    expect(parseDoubaoLogLine(mac, windowsFile)).toBeUndefined();
    expect(parseDoubaoLogLine(win.replace(':CONSOLE(0)', ':FRONTEND(0)'), windowsFile)).toBeUndefined();
    expect(parseDoubaoLogLine(mac.replace(':FRONTEND(0)', ':CONSOLE(0)'), windowsFile)).toBeUndefined();
  });

  it('discovers Windows logs, baselines old turns and resumes a new turn without replay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-win-')); temporary.push(root);
    const logs = path.join(root, 'logs'); await mkdir(logs);
    await writeFile(path.join(logs, windowsFile.replace('saman_', 'saman_repair_')), '');
    expect(await DoubaoWorkInput.checkAvailability(logs)).toBe(false);
    const file = path.join(logs, windowsFile);
    await writeFile(file, windowsLine('on_message_session_end', 100));
    expect(await DoubaoWorkInput.checkAvailability(logs)).toBe(true);
    const statePath = path.join(root, 'state.json');
    const state = new StateStore(statePath);
    const input = new ProbeInput({ stateStore: state, logDir: logs });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    expect(await input.poll()).toEqual([]); clock.mockRestore();
    await appendFile(file, windowsLine('on_message_session_start', 10));
    expect(await input.poll()).toEqual([]); await state.save();
    const restored = new StateStore(statePath); await restored.load();
    const resumed = new ProbeInput({ stateStore: restored, logDir: logs });
    await appendFile(file, windowsLine('on_message_session_end', 3000));
    const entries = await resumed.poll();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.time_unix_nano)).toEqual([
      (BigInt(DOUBAO_EPOCH) * 1_000_000n).toString(),
      (BigInt(DOUBAO_EPOCH + 3000) * 1_000_000n).toString(),
    ]);
    await appendFile(file, windowsLine('on_message_session_end', 3000));
    expect(await resumed.poll()).toEqual([]);
  });

  it('uses LOCALAPPDATA on Windows and falls back to the user profile', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.stubEnv('LOCALAPPDATA', 'D:\\Synthetic User\\Local');
      expect(DoubaoWorkInput.defaultLogDir()).toBe('D:\\Synthetic User\\Local\\DoubaoWork\\User Data\\sdk_storage\\log');
      delete process.env.LOCALAPPDATA;
      expect(DoubaoWorkInput.defaultLogDir()).toBe(path.win32.join(homedir(), 'AppData', 'Local', 'DoubaoWork', 'User Data', 'sdk_storage', 'log'));
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
