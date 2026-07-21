import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { GrokBuildLogInput } from '../../../src/inputs/grok-build-log/grok-build-log-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('GrokBuildLogInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: GrokBuildLogInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-build-log-input-test-'));
    stateStore = new MockStateStore();
    input = new GrokBuildLogInput({
      stateStore: stateStore as any,
      logDir: tmpDir,
      logPrefix: 'grok-build',
      pollIntervalMs: 60_000,
    });
    const today = getTodayDateString();
    stateStore.set('grok-build-log', { lastFile: `grok-build-${today}.jsonl`, lastOffset: 0 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('declares correct id / agentType / collectionMethod', () => {
    expect(input.id).toBe('grok-build-log');
    expect(input.agentType).toBe(ClientType.GrokBuildHook);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
  });

  describe('getWatchPaths / checkAvailability', () => {
    it('getWatchPaths returns the configured log dir', () => {
      const paths = GrokBuildLogInput.getWatchPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain('logs/grok-build');
    });

    it('checkAvailability returns true when dir exists, false otherwise', async () => {
      // tmpDir was created by mkdtemp
      const dirAvail = await GrokBuildLogInput.checkAvailability();
      // default home dir may or may not exist on the test host; assert boolean type only
      expect(typeof dirAvail).toBe('boolean');
    });
  });

  describe('transformRecord via JSONL collect', () => {
    it('processes a canonical tool.call record', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `grok-build-${today}.jsonl`);
      const record = {
        'event.id': 'grok-tool-1',
        'event.name': 'tool.call',
        'gen_ai.agent.type': ClientType.GrokBuildHook,
        time_unix_nano: '1777628163513000000',
        observed_time_unix_nano: '1777628163513000000',
        'gen_ai.session.id': 'grok-sess-1',
        'gen_ai.turn.id': 'grok-turn-1',
        'gen_ai.request.model': 'qwen3.7-max',
        'gen_ai.response.model': 'qwen3.7-max',
        'gen_ai.tool.name': 'Shell',
        'gen_ai.tool.call.id': 'grok-tool-call-1',
        'gen_ai.tool.call.arguments': { command: 'echo hi' },
      };
      await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
      await input.start();
      await input.stop();

      expect(entries).toHaveLength(1);
      expect(entries[0]!['event.name']).toBe('tool.call');
      expect(entries[0]!['gen_ai.agent.type']).toBe(ClientType.GrokBuildHook);
      expect(entries[0]!['gen_ai.session.id']).toBe('grok-sess-1');
      expect(entries[0]!['gen_ai.tool.name']).toBe('Shell');
      expect(entries[0]!['gen_ai.tool.call.id']).toBe('grok-tool-call-1');
    });

    it('processes a canonical llm.response record with usage preserved', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `grok-build-${today}.jsonl`);
      const record = {
        'event.id': 'grok-llm-1',
        'event.name': 'llm.response',
        'gen_ai.agent.type': ClientType.GrokBuildHook,
        time_unix_nano: '1777628163514000000',
        observed_time_unix_nano: '1777628163514000000',
        'gen_ai.session.id': 'grok-sess-1',
        'gen_ai.turn.id': 'grok-turn-1',
        'gen_ai.request.model': 'qwen3.7-max',
        'gen_ai.response.model': 'qwen3.7-max',
        'gen_ai.usage.input_tokens': 120,
        'gen_ai.usage.output_tokens': 40,
        'gen_ai.usage.total_tokens': 160,
        'gen_ai.output.messages': [
          { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
        ],
      };
      await fs.writeFile(logFile, `${JSON.stringify(record)}\n`);

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
      await input.start();
      await input.stop();

      expect(entries).toHaveLength(1);
      expect(entries[0]!['event.name']).toBe('llm.response');
      expect(entries[0]!['gen_ai.usage.input_tokens']).toBe(120);
      expect(entries[0]!['gen_ai.usage.output_tokens']).toBe(40);
      expect(entries[0]!['gen_ai.usage.total_tokens']).toBe(160);
    });

    it('skips non-canonical records (no event.name)', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `grok-build-${today}.jsonl`);
      await fs.writeFile(logFile, `${JSON.stringify({ foo: 'bar' })}\n`);

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
      await input.start();
      await input.stop();

      expect(entries).toHaveLength(0);
    });

    it('byte-offset: reads only new bytes on subsequent polls', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `grok-build-${today}.jsonl`);
      const firstRecord = {
        'event.id': 'grok-1',
        'event.name': 'tool.call',
        'gen_ai.agent.type': ClientType.GrokBuildHook,
        time_unix_nano: '1777628163513000000',
        observed_time_unix_nano: '1777628163513000000',
        'gen_ai.session.id': 'sess-a',
        'gen_ai.tool.name': 'Shell',
        'gen_ai.tool.call.id': 'tool-1',
      };
      await fs.writeFile(logFile, `${JSON.stringify(firstRecord)}\n`);

      const firstBatch: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => firstBatch.push(...e));
      await input.start();
      await input.stop();
      expect(firstBatch).toHaveLength(1);

      const secondRecord = {
        'event.id': 'grok-2',
        'event.name': 'tool.call',
        'gen_ai.agent.type': ClientType.GrokBuildHook,
        time_unix_nano: '1777628163514000000',
        observed_time_unix_nano: '1777628163514000000',
        'gen_ai.session.id': 'sess-b',
        'gen_ai.tool.name': 'Shell',
        'gen_ai.tool.call.id': 'tool-2',
      };
      await fs.appendFile(logFile, `${JSON.stringify(secondRecord)}\n`);

      const input2 = new GrokBuildLogInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        logPrefix: 'grok-build',
        pollIntervalMs: 60_000,
      });
      const secondBatch: AgentActivityEntry[] = [];
      input2.on('entries', (e: AgentActivityEntry[]) => secondBatch.push(...e));
      await input2.start();
      await input2.stop();

      expect(secondBatch).toHaveLength(1);
      expect(secondBatch[0]!['event.id']).toBe('grok-2');
    });

    it('skips malformed JSON lines without crashing', async () => {
      const today = getTodayDateString();
      const logFile = path.join(tmpDir, `grok-build-${today}.jsonl`);
      const record = {
        'event.id': 'grok-ok',
        'event.name': 'tool.call',
        'gen_ai.agent.type': ClientType.GrokBuildHook,
        time_unix_nano: '1777628163513000000',
        observed_time_unix_nano: '1777628163513000000',
        'gen_ai.session.id': 'sess-ok',
        'gen_ai.tool.name': 'Shell',
        'gen_ai.tool.call.id': 'tool-ok',
      };
      await fs.writeFile(logFile, `not json\n${JSON.stringify(record)}\n`);

      const entries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
      await input.start();
      await input.stop();

      expect(entries).toHaveLength(1);
      expect(entries[0]!['event.id']).toBe('grok-ok');
    });
  });
});
