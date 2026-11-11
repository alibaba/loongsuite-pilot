import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine, doubaoToolLine } from '../../helpers/doubao-work-fixture.js';

const windowsFile = DOUBAO_FILE.replace('saman_frontend_', 'saman_');
const windowsLine = (event: string, elapsedMs: number) => doubaoLine(event, {}, elapsedMs)
  .replace(/(\.\d{3})\d{3}:(INFO|WARNING|ERROR):FRONTEND\(0\)/, '$1:$2:CONSOLE(0)');
const windowsFrontend = (line: string) => line
  .replace(/(\.\d{3})\d{3}:(INFO|WARNING|ERROR):FRONTEND\(0\)/, '$1:$2:FRONTEND(0)');
class ProbeInput extends DoubaoWorkInput { poll() { return this.collect(); } }
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Doubao Windows client logs', () => {
  it('reads native CONSOLE millisecond boundaries and keeps macOS microseconds', () => {
    const windows = parseDoubaoLogLine(windowsLine('on_message_session_end', 1234).trimEnd(), windowsFile);
    expect(windows?.timeNano).toBe((BigInt(DOUBAO_EPOCH + 1234) * 1_000_000n).toString());
    expect(windows?.clientOutcome).toBe('received');
    const mac = parseDoubaoLogLine(doubaoLine('on_message_session_end', {}, 1234).trimEnd(), DOUBAO_FILE);
    expect(mac?.timeNano).toBe((BigInt(DOUBAO_EPOCH + 1234) * 1_000_000n + 123_000n).toString());
  });

  it('reads Windows App FRONTEND millisecond lifecycle boundaries', () => {
    const line = windowsFrontend(doubaoLine('on_message_session_end', {}, 1234)).trimEnd();
    const event = parseDoubaoLogLine(line, DOUBAO_FILE);
    expect(event?.timeNano).toBe((BigInt(DOUBAO_EPOCH + 1234) * 1_000_000n).toString());
    expect(event?.clientOutcome).toBe('received');
  });

  it('pairs FRONTEND millisecond tool boundaries without accepting another producer', () => {
    const start = windowsFrontend(doubaoToolLine({}, 100)).trimEnd();
    const end = windowsFrontend(doubaoToolLine({ toolCallID: 'synthetic-call',
      phase: 'execution_settled', status: 'success' }, 125)).trimEnd();
    expect(parseDoubaoLogLine(start, DOUBAO_FILE)?.tool?.phase).toBe('received');
    expect(parseDoubaoLogLine(end, DOUBAO_FILE)?.tool?.phase).toBe('settled');
    expect(parseDoubaoLogLine(end, DOUBAO_FILE)?.timeNano)
      .toBe((BigInt(DOUBAO_EPOCH + 125) * 1_000_000n).toString());
    expect(parseDoubaoLogLine(start.replace('local-file-local-tools-sse-wiring.ts', 'unrelated.ts'), DOUBAO_FILE))
      .toBeUndefined();
  });

  it.each(['12', '1234', '12345', '1234567', '123456789'])('rejects unsupported FRONTEND precision %s', digits => {
    const line = doubaoLine('on_message_session_end').trimEnd()
      .replace(/\.\d{6}(:INFO:FRONTEND)/, `.${digits}$1`);
    expect(parseDoubaoLogLine(line, DOUBAO_FILE)).toBeUndefined();
  });

  it('collects a Windows App FRONTEND request and paired tools once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-app-frontend-')); temporary.push(root);
    const logs = path.join(root, 'logs'); await mkdir(logs);
    const file = path.join(logs, DOUBAO_FILE); await writeFile(file, '');
    const stateStore = new StateStore(path.join(root, 'state.json'));
    const input = new ProbeInput({ stateStore, logDir: logs, client: 'doubao',
      sessionsRoot: path.join(root, 'native'), snapshotRoot: path.join(root, 'snapshots') });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    expect(await input.poll()).toEqual([]); clock.mockRestore();
    const source = windowsFrontend(doubaoLine('on_message_sending_start', {}, 10))
      + windowsFrontend(doubaoToolLine({}, 100))
      + windowsFrontend(doubaoToolLine({ toolCallID: 'synthetic-call', phase: 'execution_settled', status: 'success' }, 125))
      + windowsFrontend(doubaoLine('on_message_session_end'));
    await appendFile(file, source);
    const entries = await input.poll();
    expect(entries.map(entry => entry['event.name'])).toEqual(['other', 'tool.call', 'tool.result', 'other']);
    expect(entries.every(entry => entry['loongsuite.doubao_work.client'] === 'doubao')).toBe(true);
    expect(entries.find(entry => entry['event.name'] === 'tool.result')?.['gen_ai.tool.call.duration']).toBe(25);
    expect(entries.every(entry => BigInt(entry.time_unix_nano!) % 1_000_000n === 0n)).toBe(true);
    await appendFile(file, source);
    expect(await input.poll()).toEqual([]);
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
