import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ActionType, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('CursorHookInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: CursorHookInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-input-test-'));
    stateStore = new MockStateStore();
    input = new CursorHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'cursor',
      pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses hook record and maps final-schema session id', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      uuid: 'r-1',
      logTime: new Date().toISOString(),
      reported: false,
      clientType: 'CursorHook',
      hookEvent: 'postToolUse',
      data: {
        'session.id': 'sess-1',
        text: 'hello',
        cwd: '/workspace',
      },
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentType).toBe(ClientType.CursorHook);
    expect(entries[0]!.sessionId).toBe('sess-1');
    expect(entries[0]!.actionType).toBe(ActionType.Execute);
    expect(entries[0]!.filePath).toBe('/workspace');
    expect(entries[0]!.content).toBe('hello');
  });

  it('uses final-schema session id only', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const record = {
      uuid: 'r-2',
      logTime: new Date().toISOString(),
      reported: false,
      clientType: 'CursorHook',
      hookEvent: 'afterAgentResponse',
      data: {
        'session.id': 'sess-from-schema',
      },
    };
    await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.sessionId).toBe('sess-from-schema');
  });

  it('maps file events to read/edit actions', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `cursor-${today}.jsonl`);
    const records = [
      {
        uuid: 'r-3',
        logTime: new Date().toISOString(),
        reported: false,
        clientType: 'CursorHook',
        hookEvent: 'beforeReadFile',
        data: { file_path: '/a.ts', 'session.id': 's-read' },
      },
      {
        uuid: 'r-4',
        logTime: new Date().toISOString(),
        reported: false,
        clientType: 'CursorHook',
        hookEvent: 'afterFileEdit',
        data: { file_path: '/b.ts', 'session.id': 's-edit' },
      },
    ];
    await fs.writeFile(logFile, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(2);
    expect(entries[0]!.actionType).toBe(ActionType.Read);
    expect(entries[1]!.actionType).toBe(ActionType.Edit);
  });
});
