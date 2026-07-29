import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readInterceptData } from '../../../src/inputs/qoder-trace/intercept-token-reader.js';

vi.mock('../../../src/utils/fs-utils.js', () => ({
  resolveHome: (p: string) => p.replace('~', '/tmp/test-intercept-home'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TEST_DIR = '/tmp/test-intercept-home/.loongsuite-pilot/logs';
const TEST_FILE = path.join(TEST_DIR, 'qodercli-intercept.jsonl');

describe('intercept-token-reader', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    try { await fs.unlink(TEST_FILE); } catch {}
  });

  afterEach(async () => {
    try { await fs.rm(TEST_DIR, { recursive: true }); } catch {}
  });

  it('returns empty data when file does not exist', async () => {
    const result = await readInterceptData();
    expect(result.tokens).toEqual([]);
    expect(result.systemPrompt).toBeNull();
  });

  it('parses token records correctly', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: 'token', ts: now, id: 'req-1', prompt_tokens: 25000, cached_tokens: 24000, completion_tokens: 50, reasoning_tokens: 10, total_tokens: 25050 }),
      JSON.stringify({ type: 'token', ts: now + 1000, id: 'req-2', prompt_tokens: 26000, cached_tokens: 25000, completion_tokens: 100, reasoning_tokens: 20, total_tokens: 26100 }),
    ];
    await fs.writeFile(TEST_FILE, lines.join('\n') + '\n');

    const result = await readInterceptData(now - 1000);

    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0].id).toBe('req-1');
    expect(result.tokens[0].promptTokens).toBe(25000);
    expect(result.tokens[0].cachedTokens).toBe(24000);
    expect(result.tokens[0].completionTokens).toBe(50);
    expect(result.tokens[1].id).toBe('req-2');
    expect(result.tokens[1].promptTokens).toBe(26000);
  });

  it('parses system_prompt records', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: 'system_prompt', ts: now, content: 'You are Qoder, an AI assistant.' }),
      JSON.stringify({ type: 'token', ts: now, id: 'req-1', prompt_tokens: 100, cached_tokens: 0, completion_tokens: 10, reasoning_tokens: 0, total_tokens: 110 }),
    ];
    await fs.writeFile(TEST_FILE, lines.join('\n') + '\n');

    const result = await readInterceptData(now - 1000);

    expect(result.systemPrompt).not.toBeNull();
    expect(result.systemPrompt!.content).toBe('You are Qoder, an AI assistant.');
    expect(result.tokens).toHaveLength(1);
  });

  it('filters out records older than sinceTs', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: 'token', ts: now - 10000, id: 'old', prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }),
      JSON.stringify({ type: 'token', ts: now, id: 'recent', prompt_tokens: 500, cached_tokens: 0, completion_tokens: 50, reasoning_tokens: 0, total_tokens: 550 }),
    ];
    await fs.writeFile(TEST_FILE, lines.join('\n') + '\n');

    const result = await readInterceptData(now - 5000);

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].id).toBe('recent');
  });

  it('handles malformed lines gracefully', async () => {
    const now = Date.now();
    const lines = [
      'not valid json',
      JSON.stringify({ type: 'token', ts: now, id: 'good', prompt_tokens: 100, cached_tokens: 0, completion_tokens: 10, reasoning_tokens: 0, total_tokens: 110 }),
      '{"incomplete": true',
    ];
    await fs.writeFile(TEST_FILE, lines.join('\n') + '\n');

    const result = await readInterceptData(now - 1000);

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].id).toBe('good');
  });

  it('reads a custom filename so qodercli and qoderwork intercept files stay separate', async () => {
    const now = Date.now();
    const qoderworkFile = path.join(TEST_DIR, 'qoderwork-intercept.jsonl');
    await fs.writeFile(qoderworkFile, [
      JSON.stringify({ type: 'token', ts: now, id: 'chatcmpl-qw-1', prompt_tokens: 300, cached_tokens: 0, completion_tokens: 20, reasoning_tokens: 0, total_tokens: 320 }),
    ].join('\n') + '\n');

    // Default filename (qodercli) must not pick up the qoderwork file.
    const cliResult = await readInterceptData(now - 1000);
    expect(cliResult.tokens).toEqual([]);

    // Explicit qoderwork filename reads the right file.
    const qwResult = await readInterceptData(now - 1000, 'qoderwork-intercept.jsonl');
    expect(qwResult.tokens).toHaveLength(1);
    expect(qwResult.tokens[0].id).toBe('chatcmpl-qw-1');
    expect(qwResult.tokens[0].promptTokens).toBe(300);
  });
});
