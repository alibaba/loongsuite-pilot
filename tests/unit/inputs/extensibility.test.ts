import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseSessionInput } from '../../../src/inputs/base/base-session-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { AgentActivityEntrySchema } from '../../contract/agent-activity-schema.js';

class MockSessionInput extends BaseSessionInput {
  readonly id = 'mock-session-agent';
  readonly agentType = ClientType.Qoder;

  private readonly mockDir: string;

  constructor(opts: { stateStore: any; mockDir: string }) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.mockDir,
      filePattern: '*.jsonl',
      pollIntervalMs: 60_000,
    });
    this.mockDir = opts.mockDir;
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.mockDir);
      return entries
        .filter(e => e.endsWith('.jsonl'))
        .map(e => path.join(this.mockDir, e));
    } catch {
      return [];
    }
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const type = record.type as string;
    if (type !== 'action') return null;

    return buildTestEntry({
      sessionId: (record.session_id as string) ?? '',
      agentType: this.agentType,
      actionType: ActionType.Edit,
      filePath: (record.file_path as string) ?? '',
      timestamp: (record.timestamp as number) ?? Date.now(),
    });
  }
}

describe('US2: Extensibility - MockSessionInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register and collect data without modifying existing code', async () => {
    const file = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(file, JSON.stringify({
      type: 'action',
      session_id: 'ext-1',
      file_path: '/proj/ext.ts',
      timestamp: Date.now(),
    }) + '\n');

    const input = new MockSessionInput({ stateStore: stateStore as any, mockDir: tmpDir });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    expect(allEntries).toHaveLength(1);
    expect(allEntries[0]!.agentType).toBe(ClientType.Qoder);
    expect(allEntries[0]!.filePath).toBe('/proj/ext.ts');
  });

  it('should produce entries conforming to AgentActivityEntry schema', async () => {
    const file = path.join(tmpDir, 'valid.jsonl');
    await fs.writeFile(file, JSON.stringify({
      type: 'action',
      session_id: 'ext-valid',
      file_path: '/proj/valid.ts',
      timestamp: Date.now(),
    }) + '\n');

    const input = new MockSessionInput({ stateStore: stateStore as any, mockDir: tmpDir });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    for (const entry of allEntries) {
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it('should inherit collectionMethod from BaseSessionInput', () => {
    const input = new MockSessionInput({ stateStore: stateStore as any, mockDir: tmpDir });
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  it('should skip non-action records via processSessionLine', async () => {
    const file = path.join(tmpDir, 'mixed.jsonl');
    const lines = [
      { type: 'meta', session_id: 's1' },
      { type: 'action', session_id: 's1', file_path: '/ok.ts', timestamp: Date.now() },
      { type: 'status', progress: 50 },
    ];
    await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const input = new MockSessionInput({ stateStore: stateStore as any, mockDir: tmpDir });
    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    expect(allEntries).toHaveLength(1);
  });
});
