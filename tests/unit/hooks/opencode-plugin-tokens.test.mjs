import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../assets/plugins/opencode/plugin.mjs',
);

/**
 * Drives the REAL plugin: sets a temp data dir, imports the default export,
 * calls server() to get the live hooks, fires the event sequence that produces
 * an llm.response record, then reads the emitted JSONL back.
 */
let tmpDir;
let prevDataDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-tokens-'));
  prevDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  process.env.LOONGSUITE_PILOT_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  else process.env.LOONGSUITE_PILOT_DATA_DIR = prevDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadHooks() {
  // Cache-bust so module-level state (sessions map, logDir cache) is fresh and
  // logDir() re-reads the temp LOONGSUITE_PILOT_DATA_DIR set in beforeEach.
  const mod = await import(`${pathToFileURL(PLUGIN_PATH).href}?t=${Date.now()}_${Math.random()}`);
  return mod.default.server({}, {});
}

async function emitLlmResponse({ input, output, cacheRead, cacheWrite }) {
  const hooks = await loadHooks();
  const sessionID = 'ses_test';

  await hooks['chat.message'](
    { sessionID },
    { message: { model: { providerID: 'anthropic', modelID: 'claude' } }, parts: [{ type: 'text', text: 'hi' }] },
  );
  await hooks.event({
    event: { type: 'message.part.updated', properties: { sessionID, part: { type: 'step-start' }, time: Date.now() } },
  });
  await hooks.event({
    event: {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID,
          id: 'msg_1',
          modelID: 'claude',
          providerID: 'anthropic',
          time: { completed: Date.now() },
          tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } },
        },
      },
    },
  });

  const dir = path.join(tmpDir, 'logs', 'opencode');
  const records = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return records.filter((r) => r['event.name'] === 'llm.response');
}

describe('opencode plugin token mapping', () => {
  it('reports input_tokens as the total (non-cached + cache read + cache write)', async () => {
    // opencode passes non-cached input; plugin must add cache back.
    const [rec] = await emitLlmResponse({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 });

    expect(rec).toBeDefined();
    expect(rec['gen_ai.usage.input_tokens']).toBe(1300); // 100 + 1000 + 200
    expect(rec['gen_ai.usage.cache_read.input_tokens']).toBe(1000);
    expect(rec['gen_ai.usage.cache_creation.input_tokens']).toBe(200);
    expect(rec['gen_ai.usage.output_tokens']).toBe(50);
    expect(rec['gen_ai.usage.total_tokens']).toBe(1350); // input_total + output (plan A: no reasoning)
  });

  it('keeps cache_read <= input_tokens (the invariant that was violated before)', async () => {
    const [rec] = await emitLlmResponse({ input: 5, output: 10, cacheRead: 9000, cacheWrite: 0 });

    expect(rec['gen_ai.usage.cache_read.input_tokens']).toBeLessThanOrEqual(rec['gen_ai.usage.input_tokens']);
    expect(rec['gen_ai.usage.input_tokens']).toBe(9005);
  });

  it('is unchanged when there is no caching', async () => {
    const [rec] = await emitLlmResponse({ input: 300, output: 40, cacheRead: 0, cacheWrite: 0 });

    expect(rec['gen_ai.usage.input_tokens']).toBe(300);
    expect(rec['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect(rec['gen_ai.usage.total_tokens']).toBe(340);
  });
});
