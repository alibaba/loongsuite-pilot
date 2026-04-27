import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkInput } from '../../../src/inputs/qoder-work/qoder-work-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('QoderWorkInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let input: QoderWorkInput;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-test-'));
    stateStore = new MockStateStore();

    // Create the expected directory structure for session dir
    const sessionDir = path.join(tmpDir, 'projects');
    await fs.mkdir(sessionDir, { recursive: true });

    // QoderWorkInput's constructor uses resolveHome for the default sessionDir,
    // so we need to subclass or provide opts to override. Since the constructor
    // accepts sessionDir override, we'll use a slightly different approach.
    // Actually looking at the constructor more carefully, it doesn't accept sessionDir directly.
    // The constructor hardcodes the session dir. We'll need to mock fs operations or
    // create a wrapper. Let's test the processSessionLine method via the full collect flow
    // by preparing files in the expected dirs.

    // Since QoderWorkInput hardcodes paths, let's test processSessionLine behavior
    // by creating files in a mock structure and mocking the discover function.
  });

  afterEach(async () => {
    if (input?.running) await input.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('processSessionLine - message type handling', () => {
    it('should process assistant messages with string content', async () => {
      // Use a subclass to inject custom sessionDir
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-1');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-1',
        timestamp: new Date().toISOString(),
        cwd: '/proj',
        message: { content: 'Here is your code' },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.agentType).toBe(ClientType.QoderWork);
      expect(allEntries[0]!.actionType).toBe(ActionType.Other);
      expect(allEntries[0]!.content).toBe('Here is your code');
      await input.stop();
    });

    it('should process tool_use blocks in assistant content array', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-2');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-2',
        timestamp: new Date().toISOString(),
        cwd: '/proj',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tu-1',
            name: 'create_file',
            input: { file_path: '/proj/new.ts', content: 'export const x = 1;' },
          }],
        },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.actionType).toBe(ActionType.Create);
      expect(allEntries[0]!.filePath).toBe('/proj/new.ts');
      await input.stop();
    });

    it('should process session_meta records', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-3');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'session_meta',
        sessionId: 'ws-3',
        cwd: '/proj',
        timestamp: new Date().toISOString(),
        data: { model: 'opus' },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.extra?.messageType).toBe('session_meta');
      await input.stop();
    });

    it('should process progress records', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-4');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'progress',
        sessionId: 'ws-4',
        timestamp: new Date().toISOString(),
        data: { step: 3, total: 10 },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.extra?.messageType).toBe('progress');
      await input.stop();
    });

    it('should skip unknown record types', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-5');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'unknown_type',
        sessionId: 'ws-5',
      }) + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      expect(entries).toHaveLength(0);
      await input.stop();
    });
  });

  describe('processSessionLine - additional coverage', () => {
    it('should process user messages with string content', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-user');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'user',
        sessionId: 'ws-u',
        timestamp: new Date().toISOString(),
        cwd: '/proj',
        message: { content: 'Please help me' },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.content).toBe('Please help me');
    });

    it('should process tool_result blocks', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-tr');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-tr',
        timestamp: new Date().toISOString(),
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu-r1',
            content: 'Result output',
          }],
        },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.actionType).toBe(ActionType.Other);
    });

    it('should process text blocks in content array', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-txt');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-txt',
        timestamp: new Date().toISOString(),
        message: {
          content: [{
            type: 'text',
            text: 'Here is the explanation',
          }],
        },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

      await input.start();
      await input.stop();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.content).toBe('Here is the explanation');
    });

    it('should return null for assistant with no message', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-nomsg');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-nomsg',
      }) + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      await input.stop();
      expect(entries).toHaveLength(0);
    });

    it('should return null for records without type', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-notype');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({ data: 'no type field' }) + '\n');

      const entries: AgentActivityEntry[][] = [];
      input.on('entries', (e: AgentActivityEntry[]) => entries.push(e));

      await input.start();
      await input.stop();
      expect(entries).toHaveLength(0);
    });
  });

  describe('tool call classification - extended', () => {
    it('should classify delete_file as Delete', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-del');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-del',
        message: { content: [{ type: 'tool_use', id: 'tu-d', name: 'delete_file', input: { file_path: '/old.ts' } }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries[0]!.actionType).toBe(ActionType.Delete);
    });

    it('should classify Read tool as Read action', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-read');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-read',
        message: { content: [{ type: 'tool_use', id: 'tu-r', name: 'Read', input: { path: '/file.ts' } }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries[0]!.actionType).toBe(ActionType.Read);
    });

    it('should classify Grep tool as Search action', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-grep');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-grep',
        message: { content: [{ type: 'tool_use', id: 'tu-g', name: 'Grep', input: { pattern: 'foo', directory: '/src' } }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries[0]!.actionType).toBe(ActionType.Search);
    });

    it('should classify WebFetch tool as Browse action', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-web');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-web',
        message: { content: [{ type: 'tool_use', id: 'tu-w', name: 'WebFetch', input: { url: 'https://example.com' } }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries[0]!.actionType).toBe(ActionType.Browse);
    });

    it('should classify unknown tools as Other', async () => {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      input = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, 'slug-unk');
      await fs.mkdir(slugDir, { recursive: true });
      const file = path.join(slugDir, 'session.jsonl');
      await fs.writeFile(file, JSON.stringify({
        type: 'assistant',
        sessionId: 'ws-unk',
        message: { content: [{ type: 'tool_use', id: 'tu-u', name: 'custom_tool', input: { x: 1 } }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await input.start();
      await input.stop();
      expect(allEntries[0]!.actionType).toBe(ActionType.Other);
    });
  });

  describe('tool call classification', () => {
    async function testToolClassification(
      tmpDir: string,
      stateStore: MockStateStore,
      toolName: string,
      toolInput: Record<string, unknown>,
      expectedAction: ActionType,
    ): Promise<AgentActivityEntry> {
      const TestableInput = createTestableQoderWorkInput(tmpDir);
      const inp = new TestableInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });

      const slugDir = path.join(tmpDir, `slug-${toolName.toLowerCase()}`);
      await fs.mkdir(slugDir, { recursive: true });
      await fs.writeFile(path.join(slugDir, 'session.jsonl'), JSON.stringify({
        type: 'assistant',
        sessionId: `ws-${toolName}`,
        timestamp: new Date().toISOString(),
        cwd: '/proj',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: toolName, input: toolInput }] },
      }) + '\n');

      const allEntries: AgentActivityEntry[] = [];
      inp.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
      await inp.start();
      await inp.stop();
      return allEntries[0]!;
    }

    it('should classify Write as Create', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'Write', { path: '/f.ts', content: 'c' }, ActionType.Create);
      expect(e.actionType).toBe(ActionType.Create);
    });

    it('should classify search_replace as Edit', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'search_replace', { file_path: '/f.ts', new_string: 'x' }, ActionType.Edit);
      expect(e.actionType).toBe(ActionType.Edit);
    });

    it('should classify Edit as Edit', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'Edit', { file_path: '/f.ts', new_str: 'x' }, ActionType.Edit);
      expect(e.actionType).toBe(ActionType.Edit);
    });

    it('should classify delete_file as Delete', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'delete_file', { path: '/f.ts' }, ActionType.Delete);
      expect(e.actionType).toBe(ActionType.Delete);
    });

    it('should classify run_in_terminal as Execute', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'run_in_terminal', { command: 'npm test' }, ActionType.Execute);
      expect(e.actionType).toBe(ActionType.Execute);
    });

    it('should classify Bash as Execute', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'Bash', { command: 'ls' }, ActionType.Execute);
      expect(e.actionType).toBe(ActionType.Execute);
    });

    it('should classify read_file as Read', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'read_file', { file_path: '/f.ts' }, ActionType.Read);
      expect(e.actionType).toBe(ActionType.Read);
    });

    it('should classify search_file as Search', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'search_file', { path: '/src', pattern: 'x' }, ActionType.Search);
      expect(e.actionType).toBe(ActionType.Search);
    });

    it('should classify Glob as Search', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'Glob', { path: '/src' }, ActionType.Search);
      expect(e.actionType).toBe(ActionType.Search);
    });

    it('should classify grep_code as Search', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'grep_code', { directory: '/src', regex: 'foo' }, ActionType.Search);
      expect(e.actionType).toBe(ActionType.Search);
    });

    it('should classify search_codebase as Search', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'search_codebase', { query: 'bar' }, ActionType.Search);
      expect(e.actionType).toBe(ActionType.Search);
    });

    it('should classify fetch_content as Browse', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'fetch_content', { url: 'https://x.com' }, ActionType.Browse);
      expect(e.actionType).toBe(ActionType.Browse);
    });

    it('should classify search_web as Browse', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'search_web', { search_term: 'foo' }, ActionType.Browse);
      expect(e.actionType).toBe(ActionType.Browse);
    });

    it('should classify WebSearch as Browse', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'WebSearch', { query: 'bar' }, ActionType.Browse);
      expect(e.actionType).toBe(ActionType.Browse);
    });

    it('should classify unknown tool as Other', async () => {
      const e = await testToolClassification(tmpDir, stateStore, 'custom_tool', { x: 1 }, ActionType.Other);
      expect(e.actionType).toBe(ActionType.Other);
    });
  });
});

/**
 * Creates a testable QoderWorkInput subclass that overrides discoverSessionFiles
 * to scan the given tmpDir instead of hardcoded paths.
 */
function createTestableQoderWorkInput(tmpDir: string) {
  return class TestableQoderWorkInput extends QoderWorkInput {
    protected override async discoverSessionFiles(): Promise<string[]> {
      const files: string[] = [];
      try {
        const slugs = await fs.readdir(tmpDir);
        for (const slug of slugs) {
          const slugDir = path.join(tmpDir, slug);
          try {
            const stat = await fs.stat(slugDir);
            if (!stat.isDirectory()) continue;
            const entries = await fs.readdir(slugDir);
            for (const entry of entries) {
              if (entry.endsWith('.jsonl')) {
                files.push(path.join(slugDir, entry));
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      return files;
    }
  };
}
