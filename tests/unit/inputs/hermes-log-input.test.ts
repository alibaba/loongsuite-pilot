import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import {
  HermesLogInput,
  type HermesLogInputOptions,
} from '../../../src/inputs/hermes-log/hermes-log-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

class TestHermesLogInput extends HermesLogInput {
  async discoverOnce(): Promise<string[]> {
    return this.discoverSessionFiles();
  }

  async collectOnce(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }
}

describe('HermesLogInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-log-input-test-'));
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the Hermes identity and session-file collection method', () => {
    const input = makeInput();

    expect(input.id).toBe('hermes-agent-log');
    expect(input.agentType).toBe(ClientType.Hermes);
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
    expect(HermesLogInput.getWatchPaths()).toEqual([
      path.join(os.homedir(), '.loongsuite-pilot', 'logs', 'hermes-agent'),
    ]);
  });

  it('returns no files when the configured directory does not exist', async () => {
    const input = makeInput({ sessionDir: path.join(tmpDir, 'missing') });

    await expect(input.discoverOnce()).resolves.toEqual([]);
  });

  it('discovers matching regular files in stable order', async () => {
    const fileB = await writeRecords('hermes-agent-200.jsonl', []);
    const fileA = await writeRecords('hermes-agent-100.jsonl', []);
    await writeRecords('other-agent-100.jsonl', []);
    await fs.mkdir(path.join(tmpDir, 'hermes-agent-directory.jsonl'));

    await expect(makeInput().discoverOnce()).resolves.toEqual([fileA, fileB]);
  });

  it('supports a custom file pattern', async () => {
    const custom = await writeRecords('worker-a.log', []);
    await writeRecords('hermes-agent-100.jsonl', []);

    const files = await makeInput({ filePattern: 'worker-?.log' }).discoverOnce();

    expect(files).toEqual([custom]);
  });

  it('collects multiple process files with independent checkpoints', async () => {
    const fileB = await writeRecords('hermes-agent-202.jsonl', [makeRecord('event-b1')]);
    const fileA = await writeRecords('hermes-agent-101.jsonl', [makeRecord('event-a1')]);
    const input = makeInput();
    const initialEntries = await input.collectOnce();

    expect(initialEntries.map(entry => entry['event.id'])).toEqual([
      'event-a1',
      'event-b1',
    ]);
    expect(initialEntries.every(entry => entry['gen_ai.agent.type'] === ClientType.Hermes)).toBe(true);
    expect(stateStore.getOffset(`hermes-agent-log:${fileA}`)).toBeGreaterThan(0);
    expect(stateStore.getOffset(`hermes-agent-log:${fileB}`)).toBeGreaterThan(0);

    await appendRecord(fileA, makeRecord('event-a2'));
    expect((await input.collectOnce()).map(entry => entry['event.id'])).toEqual(['event-a2']);

    await appendRecord(fileB, makeRecord('event-b2'));
    expect((await input.collectOnce()).map(entry => entry['event.id'])).toEqual(['event-b2']);
  });

  it('does not emit existing records again after restart', async () => {
    const file = await writeRecords('hermes-agent-101.jsonl', [makeRecord('event-1')]);

    expect(await makeInput().collectOnce()).toHaveLength(1);
    expect(await makeInput().collectOnce()).toHaveLength(0);

    await appendRecord(file, makeRecord('event-2'));
    expect((await makeInput().collectOnce()).map(entry => entry['event.id'])).toEqual(['event-2']);
  });

  it('preserves Hermes skill semantic attributes', async () => {
    await writeRecords('hermes-agent-101.jsonl', [{
      ...makeRecord('skill-event'),
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'skill_view',
      'gen_ai.skill.name': 'loongsuite-pr-review',
      'gen_ai.skill.id': 'skill-pr-review',
      'gen_ai.skill.description': 'Review LoongSuite PR readiness.',
      'gen_ai.skill.version': '1.2.3',
    }]);

    const [entry] = await makeInput().collectOnce();

    expect(entry?.['gen_ai.skill.name']).toBe('loongsuite-pr-review');
    expect(entry?.['gen_ai.skill.id']).toBe('skill-pr-review');
    expect(entry?.['gen_ai.skill.description']).toBe('Review LoongSuite PR readiness.');
    expect(entry?.['gen_ai.skill.version']).toBe('1.2.3');
  });

  it('waits for an incomplete UTF-8 JSONL line before advancing its byte offset', async () => {
    const file = path.join(tmpDir, 'hermes-agent-101.jsonl');
    const outputMessages = [
      { role: 'assistant', parts: [{ type: 'text', content: '你好，Hermes' }] },
    ];
    const record = {
      ...makeRecord('event-unicode'),
      'gen_ai.output.messages': outputMessages,
    };
    const completeLine = Buffer.from(`${JSON.stringify(record)}\n`);
    const unicodeStart = completeLine.indexOf(Buffer.from('你好，Hermes'));
    expect(unicodeStart).toBeGreaterThanOrEqual(0);
    const splitAt = unicodeStart + 1;
    const stateKey = `hermes-agent-log:${file}`;

    await fs.writeFile(file, completeLine.subarray(0, splitAt));
    const input = makeInput();

    await expect(input.collectOnce()).resolves.toEqual([]);
    expect(stateStore.getOffset(stateKey)).toBe(0);

    await fs.appendFile(file, completeLine.subarray(splitAt));
    const entries = await input.collectOnce();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.['event.id']).toBe('event-unicode');
    expect(entries[0]?.['gen_ai.output.messages']).toEqual(outputMessages);
    expect(stateStore.getOffset(stateKey)).toBe(completeLine.length);
  });

  it('skips malformed lines without blocking later records or appends', async () => {
    const file = path.join(tmpDir, 'hermes-agent-101.jsonl');
    await fs.writeFile(
      file,
      `not-json\n${JSON.stringify(makeRecord('event-1'))}\n`,
    );
    const input = makeInput();

    expect((await input.collectOnce()).map(entry => entry['event.id'])).toEqual(['event-1']);

    await appendRecord(file, makeRecord('event-2'));
    expect((await input.collectOnce()).map(entry => entry['event.id'])).toEqual(['event-2']);
  });

  // Reproducing EACCES needs real permission checks; root bypasses them.
  const itNonRoot =
    typeof process.getuid === 'function' && process.getuid() !== 0 ? it : it.skip;

  itNonRoot(
    'diagnoses an unreadable session directory once instead of failing silently',
    async () => {
      const lockedDir = path.join(tmpDir, 'locked');
      await fs.mkdir(lockedDir);
      await fs.writeFile(
        path.join(lockedDir, 'hermes-agent-100.jsonl'),
        JSON.stringify(makeRecord('event-1')) + '\n',
      );
      // The plugin creates this directory 0700 inside its host process; a
      // differently-privileged writer makes it unreadable for this daemon.
      await fs.chmod(lockedDir, 0o000);

      const input = makeInput({ sessionDir: lockedDir });
      const warnSpy = vi.spyOn((input as any).logger, 'warn');

      try {
        await expect(input.discoverOnce()).resolves.toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0][0]);
        expect(message).toContain('ownership-mismatch');
        expect(message).toContain('session directory');

        // The condition is stable across cycles; the warning is not repeated.
        await expect(input.discoverOnce()).resolves.toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
        await fs.chmod(lockedDir, 0o755).catch(() => {});
      }
    },
  );

  function makeInput(
    overrides: Partial<Omit<HermesLogInputOptions, 'stateStore'>> = {},
  ): TestHermesLogInput {
    return new TestHermesLogInput({
      stateStore: stateStore as any,
      sessionDir: tmpDir,
      pollIntervalMs: 60_000,
      ...overrides,
    });
  }

  async function writeRecords(
    fileName: string,
    records: Record<string, unknown>[],
  ): Promise<string> {
    const file = path.join(tmpDir, fileName);
    await fs.writeFile(
      file,
      records.map(record => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''),
    );
    return file;
  }
});

async function appendRecord(file: string, record: Record<string, unknown>): Promise<void> {
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);
}

function makeRecord(eventId: string): Record<string, unknown> {
  return {
    'event.id': eventId,
    'event.name': 'llm.response',
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.turn.id': 'turn-1',
    'gen_ai.step.id': eventId,
    'gen_ai.agent.type': 'untrusted-source-value',
    'gen_ai.provider.name': 'alibaba',
    'gen_ai.request.model': 'qwen3-coder-plus',
    'gen_ai.response.model': 'qwen3-coder-plus',
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: eventId }] }],
  };
}
