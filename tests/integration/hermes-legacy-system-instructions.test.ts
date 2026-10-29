import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

describe('Hermes 4.16 system instruction masking and trace flow', () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['chat_completions', 'anthropic_messages', 'bedrock_converse', 'codex_responses'])(
    'masks legacy %s instructions before export and preserves them on LLM spans', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-legacy-flow-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ userId: 'fixture-user' }));
    const fakeKey = 'sk-' + 'a'.repeat(48);
    const prompt = `Follow the synthetic rule with ${fakeKey}`;
    const driver = await fs.readFile('tests/helpers/hermes-legacy-system-driver.py', 'utf8');
    const scenario = `
begin()
request(AIAgent(api_mode=${JSON.stringify(mode)}), ${JSON.stringify(prompt)})
finish()
`;
    const run = spawnSync('python3', ['-c', driver + scenario,
      path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py')], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: root,
        AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
        LOONGSUITE_PILOT_USER_ID: '',
        LOONGSUITE_USER_ID: '',
        LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);

    const input = new HermesLogInput({
      stateStore: new MockStateStore() as any,
      sessionDir: path.join(root, 'logs', 'hermes-agent'),
      pollIntervalMs: 60_000,
    });
    const flusher = new MockFlusher();
    const manager = new InputManager();
    manager.setMaskConfig({ mode: 'all', types: [] });
    manager.setFlusher(flusher);
    manager.registerInput(input);
    await manager.startInput(input.id);
    await manager.stopInput(input.id);
    const records = flusher.batchCalls.flat();
    const requests = records.filter(r => r['event.name'] === 'llm.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]['gen_ai.system_instructions']).toEqual([
      { type: 'text', content: 'Follow the synthetic rule with [APIKEY_MASKED]' },
    ]);
    expect(JSON.stringify(records)).not.toContain(fakeKey);
    expect(JSON.stringify(requests[0]['gen_ai.input.messages'])).not.toContain('synthetic rule');

    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    try {
      const converted = await convertEventLogToReadableSpans(records.filter(r =>
        r['event.name'] !== 'agent.input') as EventLogRecord[], { strict: false });
      expect(converted.warnings).toEqual([]);
      const llm = converted.spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llm).toHaveLength(1);
      expect(JSON.parse(String(llm[0].attributes['gen_ai.system_instructions'])))
        .toEqual(requests[0]['gen_ai.system_instructions']);
      expect(JSON.stringify(converted.spans.map(s => s.attributes))).not.toContain(fakeKey);
    } finally {
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
    }
  });
});
