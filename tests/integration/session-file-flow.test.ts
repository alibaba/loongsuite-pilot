import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { OpenclawInput } from '../../src/inputs/openclaw/openclaw-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';

describe('Session file integration flow', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sess-integ-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should perform complete discover → line processing → offset persist flow', async () => {
    const sessionDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, 'session-abc.jsonl');
    const records = [
      { type: 'session_meta', session_id: 'integ-oc-1', model: 'opus', cwd: '/proj' },
      { type: 'tool_call', tool_name: 'write_file', file_path: '/proj/a.ts', content: 'code', timestamp: Date.now() },
      { type: 'tool_call', tool_name: 'edit_file', file_path: '/proj/b.ts', timestamp: Date.now() },
    ];
    await fs.writeFile(sessionFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const input = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      filePattern: 'session-*.jsonl',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // session_meta is skipped (returns null), 2 tool_calls produce entries
    expect(allEntries).toHaveLength(2);
    expect(allEntries[0]!.agentType).toBe(ClientType.Openclaw);
    expect(allEntries[0]!.sessionId).toBe('integ-oc-1');
    expect(allEntries[0]!.actionType).toBe(ActionType.Create);
    expect(allEntries[1]!.actionType).toBe(ActionType.Edit);

    // Schema validation
    for (const entry of allEntries) {
      expect(AgentActivityEntrySchema.safeParse(entry).success).toBe(true);
    }

    // Verify offset persisted
    await stateStore.save();
    const stateKey = `openclaw:${sessionFile}`;
    const offset = stateStore.getOffset(stateKey);
    expect(offset).toBeGreaterThan(0);

    // Re-read with same state: no new entries
    const input2 = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      filePattern: 'session-*.jsonl',
      pollIntervalMs: 60_000,
    });
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();
    expect(newEntries).toHaveLength(0);
  });

  it('should handle incremental appends to session file', async () => {
    const sessionDir = path.join(tmpDir, 'sessions2');
    await fs.mkdir(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, 'session-inc.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      type: 'tool_call', tool_name: 'write_file', file_path: '/first.ts', timestamp: Date.now(),
    }) + '\n');

    const input = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();
    expect(allEntries).toHaveLength(1);

    // Append more data
    await fs.appendFile(sessionFile, JSON.stringify({
      type: 'tool_call', tool_name: 'edit_file', file_path: '/second.ts', timestamp: Date.now(),
    }) + '\n');

    await stateStore.save();

    const input2 = new OpenclawInput({
      stateStore: stateStore as any,
      sessionDir,
      pollIntervalMs: 60_000,
    });
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();

    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]!.filePath).toBe('/second.ts');
  });
});
