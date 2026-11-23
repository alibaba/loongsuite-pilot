import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { DoubaoChatReader, decodeChatWriteBatch } from '../../../src/inputs/doubao-work/doubao-chat-reader.js';
import { DoubaoWorkBudget } from '../../../src/inputs/doubao-work/doubao-work-budget.js';
import { applyAgentContentPolicy } from '../../../src/normalization/agent-content-policy.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { chatBatch, chatTable, chatWal } from '../../helpers/doubao-chat-fixture.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../helpers/doubao-work-fixture.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async () => ({ ...await vi.importActual<typeof import('node:os')>('node:os'), homedir: () => fixture.home }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
class Probe extends DoubaoWorkInput { poll() { return this.collect(); } }
const budget = () => new DoubaoWorkBudget(null, { bytes: 16 * 1024 * 1024, records: 65536, milliseconds: Infinity });

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  fixture.home = await mkdtemp(path.join(tmpdir(), 'doubao-chat-')); roots.push(fixture.home);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const root = path.join(fixture.home, 'Library/Application Support/Doubao');
  const directory = path.join(root, 'Profile 2/IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb');
  const logs = path.join(root, 'sdk_storage/log');
  await mkdir(directory, { recursive: true }); await mkdir(logs, { recursive: true });
  const file = path.join(directory, '000003.log'), log = path.join(logs, DOUBAO_FILE);
  await writeFile(file, ''); await writeFile(log, '');
  return { root, file, log, store: new StateStore(path.join(fixture.home, 'state.json')) };
}

function lifecycle(session = 'synthetic-chat-turn', queryMs = DOUBAO_EPOCH, terminal: Record<string, unknown> = {}): string {
  const meta = { chat_session_id: session, query_send_timestamp: queryMs, mode_type: 'fast',
    send_message_id: 'synthetic-query', receive_message_id: 'synthetic-answer' };
  return doubaoLine('on_message_session_start', meta, 10) + doubaoLine('on_message_sending_end', meta, 500)
    + doubaoLine('on_message_receiving_end', meta, 2000) + doubaoLine('on_message_session_end', { ...meta, ...terminal }, 3000);
}

describe('Doubao ordinary chat collection', () => {
  it('decodes only the task-store key and retains evidenced message identities', () => {
    const result = decodeChatWriteBatch(chatBatch());
    expect(result).toHaveLength(1);
    expect(result[0].value).toMatchObject({ sessionId: 'synthetic-chat-turn', input: 'SYNTHETIC_CHAT_INPUT',
      output: 'SYNTHETIC_CHAT_OUTPUT', finished: true, modelId: '38' });
    const unrelated = chatBatch(); unrelated[17] = 0;
    expect(decodeChatWriteBatch(unrelated)).toEqual([]);
  });

  it('retries half-records, validates checksums and reads no body on unchanged polls', async () => {
    const { root, file } = await setup(); const reader = new DoubaoChatReader(root);
    const raw = chatWal([chatBatch()]); await writeFile(file, raw.subarray(0, raw.length - 5));
    expect(await reader.find('synthetic-chat-turn', budget())).toBeUndefined();
    await appendFile(file, raw.subarray(raw.length - 5));
    expect((await reader.find('synthetic-chat-turn', budget()))?.finished).toBe(true);
    const previous = reader.stats().bodyReadBytes; await reader.find('synthetic-chat-turn', budget());
    expect(reader.stats().bodyReadBytes).toBe(previous);
    const corrupt = Buffer.from(raw); corrupt[50] ^= 1; await writeFile(file, corrupt);
    await expect(new DoubaoChatReader(root).find('synthetic-chat-turn', budget())).rejects.toThrow('checksum');
  });

  it('continues fragmented batches across bounded collection cycles', async () => {
    const { root, file } = await setup();
    await writeFile(file, chatWal([chatBatch({ output: 'x'.repeat(180000) })]));
    const reader = new DoubaoChatReader(root); let result;
    for (let cycle = 0; cycle < 10 && !result; cycle++) {
      try { result = await reader.find('synthetic-chat-turn', new DoubaoWorkBudget(null, { bytes: 65536, milliseconds: Infinity })); }
      catch (error) { expect((error as Error).message).toBe('cycle_budget'); }
    }
    expect(result?.output).toHaveLength(180000);
  });

  it.each([false, true])('recovers from immutable tables after WAL rotation (compressed=%s)', async compressed => {
    const { root, file } = await setup();
    await writeFile(file, chatWal([chatBatch({ finished: false })]));
    const reader = new DoubaoChatReader(root);
    expect((await reader.find('synthetic-chat-turn', budget()))?.finished).toBe(false);
    await writeFile(path.join(path.dirname(file), '000004.ldb'), chatTable(chatBatch({ sequence: 2 }), compressed));
    await rm(file);
    expect((await reader.find('synthetic-chat-turn', budget()))?.finished).toBe(true);
    expect((await new DoubaoChatReader(root).find('synthetic-chat-turn', budget()))?.output).toBe('SYNTHETIC_CHAT_OUTPUT');
  });

  it('recovers subsequent valid writes after corruption and same-inode replacement', async () => {
    const { root, file } = await setup();
    const corrupt = chatWal([chatBatch()]); corrupt[50] ^= 1;
    await writeFile(file, corrupt);
    const reader = new DoubaoChatReader(root);
    await expect(reader.find('synthetic-chat-turn', budget())).rejects.toThrow('checksum');
    await appendFile(file, chatWal([chatBatch({ sequence: 2 })]));
    expect((await reader.find('synthetic-chat-turn', budget()))?.finished).toBe(true);
    await writeFile(file, chatWal([chatBatch({ sequence: 3, output: 'replacement'.repeat(300) })]));
    expect((await reader.find('synthetic-chat-turn', budget()))?.output).toBe('replacement'.repeat(300));
  });

  it('keeps a request pending when another source could contain a newer unreadable record', async () => {
    const { root, file } = await setup();
    await writeFile(file, chatWal([chatBatch()]));
    const newer = path.join(path.dirname(file), '000004.log');
    const corrupt = chatWal([chatBatch({ sequence: 2, output: 'NEWER_OUTPUT' })]);
    corrupt[50] ^= 1;
    await writeFile(newer, corrupt);
    const reader = new DoubaoChatReader(root);
    await expect(reader.find('synthetic-chat-turn', budget())).rejects.toThrow('checksum');
    await expect(reader.find('synthetic-chat-turn', budget())).rejects.toThrow('checksum');
    await writeFile(newer, chatWal([chatBatch({ sequence: 3, output: 'RECOVERED_OUTPUT' })]));
    expect((await reader.find('synthetic-chat-turn', budget()))?.output).toBe('RECOVERED_OUTPUT');
  });

  it('preserves pending content through checkpoint reload and late final write', async () => {
    const { store, file, log } = await setup();
    const input = new Probe({ stateStore: store, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
    await appendFile(log, lifecycle()); await writeFile(file, chatWal([chatBatch({ finished: false })]));
    expect(await input.poll()).toEqual([]); await store.save();
    const reloaded = new StateStore(path.join(fixture.home, 'state.json')); await reloaded.load();
    await writeFile(path.join(path.dirname(file), '000004.ldb'), chatTable(chatBatch({ sequence: 2 }), true)); await rm(file);
    const next = new Probe({ stateStore: reloaded, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    expect(await next.poll()).toHaveLength(2); expect(await next.poll()).toEqual([]);
  });

  it('waits for late final content, uses default App input and survives checkpoint reload', async () => {
    const { store, file, log } = await setup();
    const input = new Probe({ stateStore: store, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
    await appendFile(log, lifecycle()); await writeFile(file, chatWal([chatBatch({ finished: false })]));
    expect(await input.poll()).toEqual([]);
    await appendFile(file, chatWal([chatBatch({ sequence: 2 })]));
    const events = await input.poll(); expect(events).toHaveLength(2);
    expect(events.every(event => event['gen_ai.agent.type'] === 'doubao')).toBe(true);
    expect(events[0]['gen_ai.input.messages_delta']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'SYNTHETIC_CHAT_INPUT' }] }]);
    expect(events[0]['agent.doubao_work.chat_response_end']).toBe(String(BigInt(DOUBAO_EPOCH + 2000) * 1000000n + 123000n));
    expect(events[1]['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'SYNTHETIC_CHAT_OUTPUT' }] }]);
    expect(JSON.stringify(events.map(event => applyAgentContentPolicy(event, { doubao: { captureMessageContent: false } })))).not.toContain('SYNTHETIC_CHAT');
    await store.save(); const reloaded = new StateStore(path.join(fixture.home, 'state.json')); await reloaded.load();
    expect(await new Probe({ stateStore: reloaded, inputId: 'doubao', workBudget: { milliseconds: Infinity } }).poll()).toEqual([]);
  });

  it('refuses a mismatched native message and isolates repeated requests in one conversation', async () => {
    const { store, file, log } = await setup();
    const input = new Probe({ stateStore: store, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
    await appendFile(log, lifecycle()); await writeFile(file, chatWal([chatBatch({ localMessage: 'unrelated' })]));
    expect(await input.poll()).toEqual([]);
    await appendFile(file, chatWal([chatBatch({ sequence: 2 })]));
    const first = await input.poll(); expect(first).toHaveLength(2);
    await appendFile(log, lifecycle('next-chat-turn', DOUBAO_EPOCH + 100));
    await appendFile(file, chatWal([chatBatch({ sequence: 3, session: 'next-chat-turn', reused: true, queryMs: DOUBAO_EPOCH + 110 })]));
    const second = await input.poll(); expect(second).toHaveLength(2);
    expect(second[0].trace_id).not.toBe(first[0].trace_id); expect(await input.poll()).toEqual([]);
  });

  it('exports a complete chat tree using the source receive boundary and content policy', async () => {
    const { store, file, log } = await setup();
    const input = new Probe({ stateStore: store, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
    await appendFile(log, lifecycle()); await writeFile(file, chatWal([chatBatch()]));
    const records = await input.poll(); const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:1' }],
      serviceName: 'synthetic-doubao-chat' }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(records); await flusher.flush();
      expect(spans).toHaveLength(4);
      expect(spans.map(span => span.attributes['gen_ai.span.kind']).sort()).toEqual(['AGENT', 'ENTRY', 'LLM', 'STEP']);
      const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
      expect(llm.attributes['gen_ai.input.messages']).toContain('SYNTHETIC_CHAT_INPUT');
      expect(llm.attributes['gen_ai.output.messages']).toContain('SYNTHETIC_CHAT_OUTPUT');
      expect(llm.attributes['gen_ai.request.model']).toBeUndefined();
      expect(llm.endTime).toEqual([Math.floor((DOUBAO_EPOCH + 2000) / 1000), ((DOUBAO_EPOCH + 2000) % 1000) * 1000000 + 123000]);
      expect(spans.every(span => span.attributes['loongsuite.doubao_work.mode'] === 'chat')).toBe(true);
      for (const span of spans.filter(span => span.parentSpanId)) {
        expect(spans.some(parent => parent.spanContext().spanId === span.parentSpanId)).toBe(true);
      }
    } finally { await flusher.shutdown(); }
  });

  it.each([true, false])('applies masking and content policy through JSONL and OTLP (capture=%s)', async capture => {
    const { store, file, log } = await setup(), spans: ReadableSpan[] = [];
    const secret = 'sk-' + 'x'.repeat(24), outputDir = path.join(fixture.home, 'output');
    const trace = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:1' }], serviceName: 'synthetic-chat-mask' }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    const output = new MultiFlusher([new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false }), trace]);
    const manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-user');
    manager.setAgentsConfig({ doubao: { captureMessageContent: capture } });
    manager.setMaskConfig({ mode: 'all', types: [] });
    const input = new Probe({ stateStore: store, inputId: 'doubao', pollIntervalMs: 100, workBudget: { milliseconds: Infinity } });
    manager.registerInput(input);
    try {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
      await output.start(); await manager.startInput('doubao');
      await appendFile(log, lifecycle()); await writeFile(file, chatWal([chatBatch({ input: secret, output: secret })]));
      await vi.waitFor(() => expect(spans).toHaveLength(4)); await manager.stopAll(); await output.flush();
      const events = await readFile(path.join(outputDir, 'doubao-all.jsonl'), 'utf8');
      expect(events).not.toContain(secret); expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret);
      if (!capture) {
        expect(events).not.toContain('gen_ai.input.messages'); expect(events).not.toContain('gen_ai.output.messages');
        expect(spans.every(span => span.attributes['gen_ai.input.messages'] === undefined && span.attributes['gen_ai.output.messages'] === undefined)).toBe(true);
      }
      expect(spans.some(span => span.attributes['gen_ai.user.id'] === 'synthetic-user')).toBe(true);
    } finally { await manager.stopAll(); await output.shutdown(); }
  });

  it.each([{ cancel_source: 'user' }, { session_success: 0 }])('preserves explicit client failure and partial output (%j)', async terminal => {
    const { store, file, log } = await setup(), spans: ReadableSpan[] = [];
    const input = new Probe({ stateStore: store, inputId: 'doubao', workBudget: { milliseconds: Infinity } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.poll(); clock.mockRestore();
    await appendFile(log, lifecycle('synthetic-chat-turn', DOUBAO_EPOCH, terminal));
    await writeFile(file, chatWal([chatBatch({ finished: false, output: 'PARTIAL_OUTPUT' })]));
    const records = await input.poll(); expect(records).toHaveLength(2);
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:1' }], serviceName: 'synthetic-chat-error' }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(records); await flusher.flush(); expect(spans).toHaveLength(4);
      const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
      expect(llm.status.code).toBe(2); expect(llm.attributes['error.type']).toMatch(/doubao.client_request/);
      expect(llm.attributes['gen_ai.output.messages']).toContain('PARTIAL_OUTPUT');
      expect(llm.attributes['gen_ai.response.finish_reasons']).toBeUndefined();
    } finally { await flusher.shutdown(); }
  });
});
