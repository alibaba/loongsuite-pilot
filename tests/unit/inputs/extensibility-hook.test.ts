import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseHookInput } from '../../../src/inputs/base/base-hook-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { AgentActivityEntrySchema } from '../../contract/agent-activity-schema.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class MockHookInput extends BaseHookInput {
  readonly id = 'mock-hook-agent';
  readonly agentType = ClientType.ClaudeCliHook;

  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
    const eventType = record.event_type as string;
    if (eventType !== 'tool_use') return null;

    return buildTestEntry({
      agentType: this.agentType,
      actionType: ActionType.Edit,
      filePath: (record.file_path as string) ?? '',
      timestamp: (record.timestamp as number) ?? Date.now(),
    });
  }
}

describe('US2: Extensibility - MockHookInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-hook-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should call transformRecord for each JSONL line', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `mock-hook-${today}.jsonl`);
    await fs.writeFile(logFile,
      JSON.stringify({ event_type: 'tool_use', file_path: '/a.ts', timestamp: Date.now() }) + '\n' +
      JSON.stringify({ event_type: 'other', file_path: '/b.ts' }) + '\n',
    );

    const input = new MockHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'mock-hook',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // Only tool_use events are processed
    expect(allEntries).toHaveLength(1);
    expect(allEntries[0]!.agentType).toBe(ClientType.ClaudeCliHook);
  });

  it('should have offset management handled by base class', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `mock-hook-${today}.jsonl`);
    await fs.writeFile(logFile,
      JSON.stringify({ event_type: 'tool_use', file_path: '/first.ts', timestamp: Date.now() }) + '\n',
    );

    const input = new MockHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'mock-hook',
      pollIntervalMs: 60_000,
    });

    await input.start();
    await input.stop();

    const offset = stateStore.getOffset('mock-hook-agent');
    expect(offset).toBeGreaterThan(0);

    // Append more data
    await fs.appendFile(logFile,
      JSON.stringify({ event_type: 'tool_use', file_path: '/second.ts', timestamp: Date.now() }) + '\n',
    );

    const input2 = new MockHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'mock-hook',
      pollIntervalMs: 60_000,
    });
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();

    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]!.filePath).toBe('/second.ts');
  });

  it('should produce schema-valid entries', async () => {
    const today = getTodayDateString();
    const logFile = path.join(tmpDir, `mock-hook-${today}.jsonl`);
    await fs.writeFile(logFile,
      JSON.stringify({ event_type: 'tool_use', file_path: '/valid.ts', timestamp: Date.now() }) + '\n',
    );

    const input = new MockHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'mock-hook',
      pollIntervalMs: 60_000,
    });
    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    for (const entry of allEntries) {
      expect(AgentActivityEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('should inherit collectionMethod from BaseHookInput', () => {
    const input = new MockHookInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'mock-hook',
      pollIntervalMs: 60_000,
    });
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
  });
});
