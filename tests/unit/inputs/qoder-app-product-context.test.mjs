import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let dataDir, transcript, collector, state;
const epoch = Date.UTC(2026, 10, 1);
function appendTurn(index, file = transcript, product) {
  const rows = [
    { type: 'user', uuid: `prompt-${index}`, promptId: `prompt-${index}`, entrypoint: 'cli',
      ...(product === undefined ? {} : { businessIdentity: { product } }),
      timestamp: new Date(epoch + index * 10000).toISOString(), message: { role: 'user', content: `prompt ${index}` } },
    { type: 'assistant', timestamp: new Date(epoch + index * 10000 + 1000).toISOString(),
      message: { id: `response-${index}`, model: 'synthetic-model', role: 'assistant', stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 }, content: [{ type: 'text', text: `answer ${index}` }] } },
    { type: 'last-prompt', lastPrompt: `prompt ${index}` },
  ];
  fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function wake(product, file = transcript) {
  expect(publishQoderWakeup({ session_id: path.basename(file), transcript_path: file, hook_event_name: 'Stop',
    ...(product === undefined ? {} : { parent_business_info: { product } }),
  }, { dataDir, agentId: 'qoder' })).toBe(true);
}
async function collect() {
  const batch = await collector.collect(state);
  state = batch.state;
  await collector.acknowledge(state);
  return batch.records;
}
const types = records => [...new Set(records.map(record => record['gen_ai.agent.type']))];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-product-context-'));
  transcript = path.join(dataDir, 'session.jsonl'); state = {};
  collector = new QoderTranscriptCollector({ dataDir, agentId: 'qoder', stableMs: 0, settleMs: 0 });
});
afterEach(() => { collector.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('Qoder product identity follows the owning native Turn', () => {
  it.each([['app', 'cli', 'qoder-app'], ['cli', 'app', 'qoder-cli']])(
    'prefers native product %s over Hook product %s', async (native, hook, expected) => {
      appendTurn(0, transcript, native); wake(hook);
      expect(types(await collect())).toEqual([expected]);
    },
  );

  it('uses a fresh native App prompt without borrowing an older CLI Hook', async () => {
    appendTurn(0); wake('cli'); await collect();
    appendTurn(1, transcript, 'app');
    expect(types(await collect())).toEqual(['qoder-app']);
  });

  it('uses the App Stop after native desktop metadata following last-prompt', async () => {
    appendTurn(0);
    fs.appendFileSync(transcript, [
      { type: 'workspace-directories', directories: ['/synthetic/workspace'] },
      { type: 'runtime-config', timestamp: epoch + 1500 },
      { type: 'active-leaf', uuid: 'response-0' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    wake('app');
    expect(types(await collect())).toEqual(['qoder-app']);
  });

  it('does not borrow an App Stop across the next prompt even with trailing metadata', async () => {
    appendTurn(0); wake('cli'); await collect();
    appendTurn(1);
    fs.appendFileSync(transcript, JSON.stringify({ type: 'active-leaf', uuid: 'response-1' }) + '\n');
    appendTurn(2); wake('app');
    const responses = (await collect()).filter(record => record['event.name'] === 'llm.response');
    expect(responses.map(record => [record['gen_ai.response.id'], record['gen_ai.agent.type']]))
      .toEqual([['response-1', 'qoder-cli'], ['response-2', 'qoder-app']]);
  });

  it('keeps different queued Stop products separate in one native session', async () => {
    appendTurn(0); wake('app'); appendTurn(1); wake('cli');
    const records = await collect();
    const responses = records.filter(record => record['event.name'] === 'llm.response');
    expect(responses.map(record => [record['gen_ai.response.id'], record['gen_ai.agent.type']]))
      .toEqual([['response-0', 'qoder-app'], ['response-1', 'qoder-cli']]);
  });

  it.each(['cli', undefined, 'other'])('does not reuse App identity after a %s resume and durable restart', async product => {
    appendTurn(0); wake('app'); expect(types(await collect())).toEqual(['qoder-app']);
    collector.stop(); state = JSON.parse(JSON.stringify(state));
    collector = new QoderTranscriptCollector({ dataDir, agentId: 'qoder', stableMs: 0, settleMs: 0 });
    appendTurn(1); wake(product);
    const resumed = await collect();
    expect(types(resumed)).toEqual(['qoder-cli']);
    expect(resumed.every(record => record['gen_ai.framework'] !== 'qoder-app')).toBe(true);
    expect(await collect()).toEqual([]);
  });

  it('does not classify an unobserved later Turn using the first source descriptor', async () => {
    appendTurn(0); wake('app'); expect(types(await collect())).toEqual(['qoder-app']);
    appendTurn(1);
    expect(types(await collect())).toEqual(['qoder-cli']);
  });

  it('keeps concurrent App and CLI sources independent', async () => {
    const second = path.join(dataDir, 'another-session.jsonl');
    appendTurn(0); wake('app'); appendTurn(1, second); wake('cli', second);
    const records = await collect();
    expect(types(records.filter(record => record['gen_ai.session.id'] === 'session.jsonl'))).toEqual(['qoder-app']);
    expect(types(records.filter(record => record['gen_ai.session.id'] === 'another-session.jsonl'))).toEqual(['qoder-cli']);
  });
});
